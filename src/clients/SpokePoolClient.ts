import { groupBy } from "lodash";
import {
  spreadEvent,
  assign,
  Contract,
  BigNumber,
  EventSearchConfig,
  Promise,
  EventFilter,
  sortEventsAscendingInPlace,
  DefaultLogLevels,
  MakeOptional,
  getDeposit,
  setDeposit,
  getNetworkName,
  getRedisDepositKey,
  assert,
  sortEventsAscending,
  filledSameDeposit,
  getCurrentTime,
  getRedis,
  AnyObject,
} from "../utils";
import { toBN, ZERO_ADDRESS, winston, paginatedEventQuery, spreadEventWithBlockNumber } from "../utils";

import { AcrossConfigStoreClient } from "./ConfigStoreClient";
import {
  Deposit,
  DepositWithBlock,
  Fill,
  FillWithBlock,
  RefundRequestWithBlock,
  SpeedUp,
  TokensBridged,
  FundsDepositedEvent,
} from "../interfaces";
import { RootBundleRelayWithBlock, RelayerRefundExecutionWithBlock } from "../interfaces";
import { HubPoolClient } from ".";

const FILL_DEPOSIT_COMPARISON_KEYS = [
  "amount",
  "originChainId",
  "relayerFeePct",
  "realizedLpFeePct",
  "depositId",
  "depositor",
  "recipient",
  "destinationChainId",
  "destinationToken",
] as const;

export class SpokePoolClient {
  private currentTime: number;
  private depositHashes: { [depositHash: string]: DepositWithBlock } = {};
  private depositHashesToFills: { [depositHash: string]: FillWithBlock[] } = {};
  private speedUps: { [depositorAddress: string]: { [depositId: number]: SpeedUp[] } } = {};
  private depositRoutes: { [originToken: string]: { [DestinationChainId: number]: boolean } } = {};
  private tokensBridged: TokensBridged[] = [];
  private rootBundleRelays: RootBundleRelayWithBlock[] = [];
  private relayerRefundExecutions: RelayerRefundExecutionWithBlock[] = [];
  private earlyDeposits: FundsDepositedEvent[] = [];
  public earliestDepositIdQueried = Number.MAX_SAFE_INTEGER;
  public latestDepositIdQueried = 0;
  public firstDepositIdForSpokePool = Number.MAX_SAFE_INTEGER;
  public lastDepositIdForSpokePool = Number.MAX_SAFE_INTEGER;
  public isUpdated = false;
  public firstBlockToSearch: number;
  public latestBlockNumber: number | undefined;
  public deposits: { [DestinationChainId: number]: DepositWithBlock[] } = {};
  public fills: { [OriginChainId: number]: FillWithBlock[] } = {};
  public refundRequests: RefundRequestWithBlock[] = [];

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    // Can be excluded. This disables some deposit validation.
    readonly configStoreClient: AcrossConfigStoreClient | null,
    readonly chainId: number,
    public spokePoolDeploymentBlock: number,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
  }

  _queryableEventNames(): { [eventName: string]: EventFilter } {
    return {
      FundsDeposited: this.spokePool.filters.FundsDeposited(),
      RequestedSpeedUpDeposit: this.spokePool.filters.RequestedSpeedUpDeposit(),
      FilledRelay: this.spokePool.filters.FilledRelay(),
      // RefundRequested: this.spokePool.filters.refundRequested(), @todo update contracts-v2
      EnabledDepositRoute: this.spokePool.filters.EnabledDepositRoute(),
      TokensBridged: this.spokePool.filters.TokensBridged(),
      RelayedRootBundle: this.spokePool.filters.RelayedRootBundle(),
      ExecutedRelayerRefundRoot: this.spokePool.filters.ExecutedRelayerRefundRoot(),
    };
  }

  getDepositsForDestinationChain(destinationChainId: number): DepositWithBlock[] {
    return this.deposits[destinationChainId] || [];
  }

  getDeposits(): DepositWithBlock[] {
    return sortEventsAscendingInPlace(Object.values(this.deposits).flat());
  }

  getTokensBridged(): TokensBridged[] {
    return this.tokensBridged;
  }

  getDepositRoutes(): { [originToken: string]: { [DestinationChainId: number]: boolean } } {
    return this.depositRoutes;
  }

  isDepositRouteEnabled(originToken: string, destinationChainId: number): boolean {
    return this.depositRoutes[originToken]?.[destinationChainId] ?? false;
  }

  getAllOriginTokens(): string[] {
    return Object.keys(this.depositRoutes);
  }

  getFills(): FillWithBlock[] {
    return sortEventsAscendingInPlace(Object.values(this.fills).flat());
  }

  getFillsForOriginChain(originChainId: number): FillWithBlock[] {
    return this.fills[originChainId] || [];
  }

  getFillsForRelayer(relayer: string): FillWithBlock[] {
    return this.getFills().filter((fill) => fill.relayer === relayer);
  }

  getFillsWithBlockInRange(startingBlock: number, endingBlock: number): FillWithBlock[] {
    return this.getFills().filter((fill) => fill.blockNumber >= startingBlock && fill.blockNumber <= endingBlock);
  }

  getRefundRequests(fromBlock?: number, toBlock?: number): RefundRequestWithBlock[] {
    return isNaN(fromBlock) || isNaN(toBlock)
      ? this.refundRequests
      : this.refundRequests.filter((request) => request.blockNumber >= fromBlock && request.blockNumber <= toBlock);
  }

  getRootBundleRelays(): RootBundleRelayWithBlock[] {
    return this.rootBundleRelays;
  }

  getLatestRootBundleId(): number {
    return this.rootBundleRelays[this.rootBundleRelays.length - 1]?.rootBundleId ?? 0;
  }

  getRelayerRefundExecutions(): RelayerRefundExecutionWithBlock[] {
    return this.relayerRefundExecutions;
  }

  getExecutedRefunds(relayerRefundRoot: string): {
    [tokenAddress: string]: {
      [relayer: string]: BigNumber;
    };
  } {
    const bundle = this.getRootBundleRelays().find((bundle) => bundle.relayerRefundRoot === relayerRefundRoot);
    if (bundle === undefined) {
      return {};
    }

    const executedRefundLeaves = this.getRelayerRefundExecutions().filter(
      (leaf) => leaf.rootBundleId === bundle.rootBundleId
    );
    const executedRefunds: { [tokenAddress: string]: { [relayer: string]: BigNumber } } = {};
    for (const refundLeaf of executedRefundLeaves) {
      const tokenAddress = refundLeaf.l2TokenAddress;
      if (executedRefunds[tokenAddress] === undefined) {
        executedRefunds[tokenAddress] = {};
      }
      const executedTokenRefunds = executedRefunds[tokenAddress];

      for (let i = 0; i < refundLeaf.refundAddresses.length; i++) {
        const relayer = refundLeaf.refundAddresses[i];
        const refundAmount = refundLeaf.refundAmounts[i];
        if (executedTokenRefunds[relayer] === undefined) {
          executedTokenRefunds[relayer] = BigNumber.from(0);
        }
        executedTokenRefunds[relayer] = executedTokenRefunds[relayer].add(refundAmount);
      }
    }
    return executedRefunds;
  }

  appendMaxSpeedUpSignatureToDeposit(deposit: DepositWithBlock): DepositWithBlock {
    const maxSpeedUp = this.speedUps[deposit.depositor]?.[deposit.depositId]?.reduce((prev, current) =>
      prev.newRelayerFeePct.gt(current.newRelayerFeePct) ? prev : current
    );

    // Only if there is a speedup and the new relayer fee is greater than the current relayer fee, save the new fee.
    if (!maxSpeedUp || maxSpeedUp.newRelayerFeePct.lte(deposit.relayerFeePct)) {
      return deposit;
    }
    return {
      ...deposit,
      speedUpSignature: maxSpeedUp.depositorSignature,
      newRelayerFeePct: maxSpeedUp.newRelayerFeePct,
    };
  }

  getDepositForFill(fill: Fill): DepositWithBlock | undefined {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { blockNumber, ...fillCopy } = fill as FillWithBlock; // Ignore blockNumber when validating the fill.
    const depositWithMatchingDepositId = this.depositHashes[this.getDepositHash(fill)];
    if (depositWithMatchingDepositId === undefined) {
      return undefined;
    }
    return this.validateFillForDeposit(fillCopy, depositWithMatchingDepositId)
      ? depositWithMatchingDepositId
      : undefined;
  }

  getValidUnfilledAmountForDeposit(deposit: Deposit): {
    unfilledAmount: BigNumber;
    fillCount: number;
    invalidFills: Fill[];
  } {
    const fillsForDeposit = this.depositHashesToFills[this.getDepositHash(deposit)];
    // If no fills then the full amount is remaining.
    if (fillsForDeposit === undefined || fillsForDeposit.length === 0) {
      return { unfilledAmount: toBN(deposit.amount), fillCount: 0, invalidFills: [] };
    }

    const { validFills, invalidFills } = fillsForDeposit.reduce(
      (groupedFills: { validFills: Fill[]; invalidFills: Fill[] }, fill: Fill) => {
        if (this.validateFillForDeposit(fill, deposit)) {
          groupedFills.validFills.push(fill);
        } else {
          groupedFills.invalidFills.push(fill);
        }
        return groupedFills;
      },
      { validFills: [], invalidFills: [] }
    );

    // Log any invalid deposits with same deposit id but different params.
    const invalidFillsForDeposit = invalidFills.filter((x) => x.depositId === deposit.depositId);
    if (invalidFillsForDeposit.length > 0) {
      this.logger.warn({
        at: "SpokePoolClient",
        chainId: this.chainId,
        message: "Invalid fills found matching deposit ID",
        deposit,
        invalidFills: Object.fromEntries(invalidFillsForDeposit.map((x) => [x.relayer, x])),
      });
    }

    // If all fills are invalid we can consider this unfilled.
    if (validFills.length === 0) {
      return { unfilledAmount: toBN(deposit.amount), fillCount: 0, invalidFills };
    }

    // Order fills by totalFilledAmount and then return the first fill's full deposit amount minus total filled amount.
    const fillsOrderedByTotalFilledAmount = validFills.sort((fillA, fillB) =>
      fillB.totalFilledAmount.gt(fillA.totalFilledAmount)
        ? 1
        : fillB.totalFilledAmount.lt(fillA.totalFilledAmount)
        ? -1
        : 0
    );

    const lastFill = fillsOrderedByTotalFilledAmount[0];
    return {
      unfilledAmount: toBN(lastFill.amount.sub(lastFill.totalFilledAmount)),
      fillCount: validFills.length,
      invalidFills,
    };
  }

  // Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
  // by the depositor as well as the realizedLpFeePct and the destinationToken, which are pulled from other clients.
  validateFillForDeposit(fill: Fill, deposit: Deposit): boolean {
    // Note: this short circuits when a key is found where the comparison doesn't match.
    // TODO: if we turn on "strict" in the tsconfig, the elements of FILL_DEPOSIT_COMPARISON_KEYS will be automatically
    // validated against the fields in Fill and Deposit, generating an error if there is a discrepency.
    return FILL_DEPOSIT_COMPARISON_KEYS.every((key) => {
      return fill[key] !== undefined && fill[key].toString() === deposit[key]?.toString();
    });
  }

  getDepositHash(event: Deposit | Fill): string {
    return `${event.depositId}-${event.originChainId}`;
  }

  // Look for the block number of the event that emitted the deposit with the target deposit ID. We know that
  // `numberOfDeposits` is strictly increasing for any SpokePool, so we can use a binary search to find the blockTag
  // where `targetDepositIdLow <= numberOfDeposits <= targetDepositIdHigh`.
  async binarySearchForBlockContainingDepositId(
    targetDepositIdLow: number,
    targetDepositIdHigh: number,
    initLow = this.spokePoolDeploymentBlock,
    initHigh = this.latestBlockNumber
  ): Promise<number | undefined> {
    assert(initLow <= initHigh, "Binary search failed because low > high");
    let low = initLow;
    let high = initHigh;
    do {
      const mid = Math.floor((high + low) / 2);
      const searchedDepositId = await this.spokePool.numberOfDeposits({ blockTag: mid });
      if (targetDepositIdLow > searchedDepositId) low = mid + 1;
      else if (targetDepositIdHigh < searchedDepositId) high = mid - 1;
      else return mid;
    } while (low <= high);
    // If we can't find a blockTag where `numberOfDeposits == targetDepositId`,
    // then its likely that the depositId was included in the same block as deposits that came after it. So we fallback
    // to returning `low` if we exit the while loop, which should be the block where depositId incremented from
    // `targetDepositId`.
    return low;
  }

  // Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
  // This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
  // of a deposit older or younger than its fixed lookback.
  async queryHistoricalDepositForFill(fill: Fill): Promise<DepositWithBlock | undefined> {
    const start = Date.now();
    if (fill.originChainId !== this.chainId) throw new Error("fill.originChainId !== this.chainid");

    // We need to update client so we know the first and last deposit ID's queried for this spoke pool client, as well
    // as the global first and last deposit ID's for this spoke pool.
    if (!this.isUpdated) {
      throw new Error("SpokePoolClient must be updated before querying historical deposits");
    }
    if (fill.depositId < this.firstDepositIdForSpokePool || fill.depositId > this.lastDepositIdForSpokePool) {
      return undefined;
    }
    if (fill.depositId >= this.earliestDepositIdQueried && fill.depositId <= this.latestDepositIdQueried) {
      return this.getDepositForFill(fill);
    }

    let deposit: DepositWithBlock, cachedDeposit: Deposit | undefined;
    const redisClient = await getRedis(this.logger);
    if (redisClient) {
      cachedDeposit = await getDeposit(getRedisDepositKey(fill), redisClient);
    }
    if (cachedDeposit) {
      deposit = cachedDeposit as DepositWithBlock;
      // Assert that cache hasn't been corrupted.
      assert(deposit.depositId === fill.depositId && deposit.originChainId === fill.originChainId);
    } else {
      // A 100 deposit buffer should be pretty wide per range and cut down on number of eth_calls
      // made by the binary search.
      const binarySearchMargin = 144; // 12 hours of deposits averaging 5 mins per deposit.
      const [blockBeforeDeposit, blockAfterDeposit] = await Promise.all([
        this.binarySearchForBlockContainingDepositId(fill.depositId - binarySearchMargin, fill.depositId),
        this.binarySearchForBlockContainingDepositId(fill.depositId + 1, fill.depositId + binarySearchMargin),
      ]);
      if (!blockBeforeDeposit || !blockAfterDeposit) {
        return undefined;
      }
      assert(blockBeforeDeposit <= blockAfterDeposit, "blockBeforeDeposit > blockAfterDeposit");

      const query = await paginatedEventQuery(
        this.spokePool,
        // TODO: When SpokePool V2 is deployed we can begin to filter on fill.depositId as well as fill.depositor,
        // which should optimize the RPC request.
        this.spokePool.filters.FundsDeposited(null, null, null, null, null, null, null, null, fill.depositor),
        {
          fromBlock: blockBeforeDeposit,
          toBlock: blockAfterDeposit,
          maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
        }
      );
      const event = (query as FundsDepositedEvent[]).find((deposit) => deposit.args.depositId === fill.depositId);
      if (event === undefined) {
        const srcChain = getNetworkName(fill.originChainId);
        const dstChain = getNetworkName(fill.destinationChainId);
        throw new Error(
          `Could not find deposit ${fill.depositId} for ${dstChain} fill` +
            ` between ${srcChain} blocks [${blockBeforeDeposit}, ${blockAfterDeposit}]`
        );
      }
      const processedEvent: Omit<DepositWithBlock, "destinationToken" | "realizedLpFeePct"> =
        spreadEventWithBlockNumber(event) as DepositWithBlock;
      const dataForQuoteTime: { realizedLpFeePct: BigNumber; quoteBlock: number } = await this.computeRealizedLpFeePct(
        event
      );
      // Append the realizedLpFeePct.
      // Append destination token and realized lp fee to deposit.
      deposit = {
        ...processedEvent,
        realizedLpFeePct: dataForQuoteTime.realizedLpFeePct,
        destinationToken: this.getDestinationTokenForDeposit(processedEvent),
        blockNumber: dataForQuoteTime.quoteBlock,
        originBlockNumber: event.blockNumber,
      };
      this.logger.debug({
        at: "SpokePoolClient",
        message: "Queried RPC for deposit outside SpokePoolClient's search range",
        deposit,
      });
      if (redisClient) {
        await setDeposit(deposit, getCurrentTime(), redisClient, 24 * 60 * 60);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { blockNumber, ...fillCopy } = fill as FillWithBlock; // Ignore blockNumber when validating the fill
    console.log(`Time elapsed for queryHistoricalDepositForFill: ${Date.now() - start}ms`);
    return this.validateFillForDeposit(fillCopy, deposit) ? deposit : undefined;
  }

  async queryHistoricalMatchingFills(fill: Fill, deposit: Deposit, toBlock: number): Promise<FillWithBlock[]> {
    const searchConfig = {
      fromBlock: this.spokePoolDeploymentBlock,
      toBlock,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    return (await this.queryFillsInBlockRange(fill, searchConfig)).filter((_fill) =>
      this.validateFillForDeposit(_fill, deposit)
    );
  }

  async queryFillsInBlockRange(matchingFill: Fill, searchConfig: EventSearchConfig): Promise<FillWithBlock[]> {
    // Filtering on the fill's depositor address, the only indexed deposit field in the FilledRelay event,
    // should speed up this search a bit.
    // TODO: Once depositId is indexed in FilledRelay event, filter on that as well.
    const query = await paginatedEventQuery(
      this.spokePool,
      this.spokePool.filters.FilledRelay(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        matchingFill.depositor,
        undefined,
        undefined
      ),
      searchConfig
    );
    const fills = query.map((event) => spreadEventWithBlockNumber(event) as FillWithBlock);
    return sortEventsAscending(fills.filter((_fill) => filledSameDeposit(_fill, matchingFill)));
  }

  async update(eventsToQuery?: string[]): Promise<void> {
    if (this.configStoreClient !== null && !this.configStoreClient.isUpdated) {
      throw new Error("RateModel not updated");
    }

    // Require that all Deposits meet the minimum specified number of confirmations.
    const [latestBlockNumber, currentTime] = await Promise.all([
      this.spokePool.provider.getBlockNumber(),
      this.spokePool.getCurrentTime(),
    ]);
    this.latestBlockNumber = latestBlockNumber;
    this.currentTime = currentTime;

    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || this.latestBlockNumber,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    if (searchConfig.fromBlock > searchConfig.toBlock) {
      this.log("warn", "Invalid update() searchConfig.", { searchConfig });
      return; // If the starting block is greater than the ending block return.
    }

    let timerStart = Date.now();

    // If caller requests specific events, then only query those. Otherwise, default to looking up all known events.
    const queryableEventNames = Object.keys(this._queryableEventNames());
    eventsToQuery ??= queryableEventNames;

    const eventSearchConfigs = eventsToQuery.map((eventName) => {
      if (!queryableEventNames.includes(eventName)) {
        throw new Error(`SpokePoolClient: Cannot query unrecognised SpokePool event name: ${eventName}`);
      }

      const _searchConfig = { ...searchConfig }; // shallow copy

      // By default, an event's query range is controlled by the `eventSearchConfig` passed in during instantiation.
      // However, certain events have special overriding requirements to their search ranges:
      // - EnabledDepositRoute: The full history is always required, so override the requested fromBlock.
      if (eventName === "EnabledDepositRoute" && !this.isUpdated) {
        _searchConfig.fromBlock = this.spokePoolDeploymentBlock;
      }

      return {
        filter: this._queryableEventNames()[eventName],
        searchConfig: _searchConfig,
      };
    });

    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      eventsToQuery,
      eventSearchConfigs,
      spokePool: this.spokePool.address,
    });

    timerStart = Date.now();
    const [_earliestDepositIdForSpokePool, _latestDepositIdForSpokePool, ...queryResults] = await Promise.all([
      this.spokePool.numberOfDeposits({ blockTag: this.spokePoolDeploymentBlock }),
      this.spokePool.numberOfDeposits(),
      ...eventSearchConfigs.map((config) => paginatedEventQuery(this.spokePool, config.filter, config.searchConfig)),
    ]);

    this.firstDepositIdForSpokePool = _earliestDepositIdForSpokePool;
    this.lastDepositIdForSpokePool = _latestDepositIdForSpokePool;
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart}ms`);

    // Sort all events to ensure they are stored in a consistent order.
    queryResults.forEach((events) => {
      sortEventsAscendingInPlace(events);
    });

    if (eventsToQuery.includes("TokensBridged")) {
      for (const event of queryResults[eventsToQuery.indexOf("TokensBridged")]) {
        this.tokensBridged.push(spreadEventWithBlockNumber(event) as TokensBridged);
      }
    }

    // For each depositEvent, compute the realizedLpFeePct. Note this means that we are only finding this value on the
    // new deposits that were found in the searchConfig (new from the previous run). This is important as this operation
    // is heavy as there is a fair bit of block number lookups that need to happen. Note this call REQUIRES that the
    // hubPoolClient is updated on the first before this call as this needed the the L1 token mapping to each L2 token.
    if (eventsToQuery.includes("FundsDeposited")) {
      const allDeposits = [
        ...(queryResults[eventsToQuery.indexOf("FundsDeposited")] as FundsDepositedEvent[]),
        ...this.earlyDeposits,
      ];
      const { earlyDeposits = [], depositEvents = [] } = groupBy(allDeposits, (depositEvent) => {
        if (depositEvent.args.quoteTimestamp > this.currentTime) {
          const { args, transactionHash } = depositEvent;
          this.logger.debug({
            at: "SpokePoolClient#update",
            message: "Deferring early deposit event.",
            currentTime: this.currentTime,
            deposit: { args, transactionHash },
          });
          return "earlyDeposits";
        } else {
          return "depositEvents";
        }
      });
      this.earlyDeposits = earlyDeposits;

      if (depositEvents.length > 0) {
        this.log("debug", `Fetching realizedLpFeePct for ${depositEvents.length} deposits on chain ${this.chainId}`, {
          numDeposits: depositEvents.length,
        });
      }

      const dataForQuoteTime: { realizedLpFeePct: BigNumber; quoteBlock: number }[] = await Promise.map(
        depositEvents,
        async (event) => this.computeRealizedLpFeePct(event)
      );

      // Now add any newly fetched events from RPC.
      if (depositEvents.length > 0) {
        this.log("debug", `Using ${depositEvents.length} newly queried deposit events for chain ${this.chainId}`, {
          earliestEvent: depositEvents[0].blockNumber,
        });
      }
      for (const [index, event] of depositEvents.entries()) {
        // Append the realizedLpFeePct.
        const processedEvent: Omit<DepositWithBlock, "destinationToken" | "realizedLpFeePct"> =
          spreadEventWithBlockNumber(event) as DepositWithBlock;

        // Append destination token and realized lp fee to deposit.
        const deposit = {
          ...processedEvent,
          realizedLpFeePct: dataForQuoteTime[index].realizedLpFeePct,
          destinationToken: this.getDestinationTokenForDeposit(processedEvent),
          blockNumber: dataForQuoteTime[index].quoteBlock,
          originBlockNumber: event.blockNumber,
        };

        assign(this.depositHashes, [this.getDepositHash(deposit)], deposit);
        assign(this.deposits, [deposit.destinationChainId], [deposit]);

        if (deposit.depositId < this.earliestDepositIdQueried) {
          this.earliestDepositIdQueried = deposit.depositId;
        }
        if (deposit.depositId > this.latestDepositIdQueried) {
          this.latestDepositIdQueried = deposit.depositId;
        }
      }
    }

    // Update deposits with speed up requests from depositor.
    if (eventsToQuery.includes("RequestedSpeedUpDeposit")) {
      const speedUpEvents = queryResults[eventsToQuery.indexOf("RequestedSpeedUpDeposit")];

      for (const event of speedUpEvents) {
        const speedUp: SpeedUp = { ...spreadEvent(event), originChainId: this.chainId };
        assign(this.speedUps, [speedUp.depositor, speedUp.depositId], [speedUp]);
      }

      // Traverse all deposit events and update them with associated speedups, If they exist.
      for (const [, deposits] of Object.entries(this.deposits)) {
        for (const [index, deposit] of deposits.entries()) {
          deposits[index] = this.appendMaxSpeedUpSignatureToDeposit(deposit);
        }
      }
    }

    if (eventsToQuery.includes("FilledRelay")) {
      const fillEvents = queryResults[eventsToQuery.indexOf("FilledRelay")];

      if (fillEvents.length > 0) {
        this.log("debug", `Using ${fillEvents.length} newly queried fill events for chain ${this.chainId}`, {
          earliestEvent: fillEvents[0].blockNumber,
        });
      }
      for (const event of fillEvents) {
        const fill = spreadEventWithBlockNumber(event) as FillWithBlock;
        assign(this.fills, [fill.originChainId], [fill]);
        assign(this.depositHashesToFills, [this.getDepositHash(fill)], [fill]);
      }
    }

    // @note: In Across 2.5, callers will simultaneously request [FundsDeposited, FilledRelay, RefundsRequested].
    // The list of events is always pre-sorted, so rather than splitting them out individually, it might make sense to
    // evaluate them as a single group, to avoid having to re-merge and sequence again afterwards.
    if (eventsToQuery.includes("RefundRequested")) {
      const refundRequests = queryResults[eventsToQuery.indexOf("RefundRequested")];

      if (refundRequests.length > 0) {
        this.log("debug", `Found ${refundRequests.length} new relayer refund requests on chain ${this.chainId}`, {
          earliestEvent: refundRequests[0].blockNumber,
        });
      }
      for (const refundRequest of refundRequests) {
        this.refundRequests.push(spreadEventWithBlockNumber(refundRequest) as RefundRequestWithBlock);
      }
    }

    if (eventsToQuery.includes("EnabledDepositRoute")) {
      const enableDepositsEvents = queryResults[eventsToQuery.indexOf("EnabledDepositRoute")];

      for (const event of enableDepositsEvents) {
        const enableDeposit = spreadEvent(event);
        assign(
          this.depositRoutes,
          [enableDeposit.originToken, enableDeposit.destinationChainId],
          enableDeposit.enabled
        );
      }
    }

    if (eventsToQuery.includes("RelayedRootBundle")) {
      const relayedRootBundleEvents = queryResults[eventsToQuery.indexOf("RelayedRootBundle")];
      for (const event of relayedRootBundleEvents) {
        this.rootBundleRelays.push(spreadEventWithBlockNumber(event) as RootBundleRelayWithBlock);
      }
    }

    if (eventsToQuery.includes("ExecutedRelayerRefundRoot")) {
      const executedRelayerRefundRootEvents = queryResults[eventsToQuery.indexOf("ExecutedRelayerRefundRoot")];
      for (const event of executedRelayerRefundRootEvents) {
        const executedRefund = spreadEventWithBlockNumber(event) as RelayerRefundExecutionWithBlock;
        executedRefund.l2TokenAddress = SpokePoolClient.getExecutedRefundLeafL2Token(
          executedRefund.chainId,
          executedRefund.l2TokenAddress
        );
        this.relayerRefundExecutions.push(executedRefund);
      }
    }

    this.firstBlockToSearch = searchConfig.toBlock + 1; // Next iteration should start off from where this one ended.

    this.isUpdated = true;
    this.log("debug", `SpokePool client for chain ${this.chainId} updated!`, {
      eventSearchConfigs,
      nextFirstBlockToSearch: this.firstBlockToSearch,
    });
  }

  static getExecutedRefundLeafL2Token(chainId: number, eventL2Token: string): string {
    // If execution of WETH refund leaf occurred on an OVM spoke pool, then we'll convert its l2Token from the native
    // token address to the wrapped token address. This is because the OVM_SpokePool modifies the l2TokenAddress prop
    // in _bridgeTokensToHubPool before emitting the ExecutedRelayerRefundLeaf event.
    // Here is the contract code referenced:
    // - https://github.com/across-protocol/contracts-v2/blob/954528a4620863d1c868e54a370fd8556d5ed05c/contracts/Ovm_SpokePool.sol#L142
    if (chainId === 10 && eventL2Token.toLowerCase() === "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000") {
      return "0x4200000000000000000000000000000000000006";
    } else if (chainId === 288 && eventL2Token.toLowerCase() === "0x4200000000000000000000000000000000000006") {
      return "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000";
    } else {
      return eventL2Token;
    }
  }

  public hubPoolClient(): HubPoolClient {
    return this.configStoreClient?.hubPoolClient as HubPoolClient;
  }

  private async computeRealizedLpFeePct(depositEvent: FundsDepositedEvent) {
    const hubPoolClient = this.hubPoolClient();
    if (!hubPoolClient || !this.configStoreClient) {
      return { realizedLpFeePct: toBN(0), quoteBlock: 0 };
    } // If there is no rate model client return 0.
    const deposit = {
      amount: depositEvent.args.amount,
      originChainId: Number(depositEvent.args.originChainId),
      destinationChainId: Number(depositEvent.args.destinationChainId),
      originToken: depositEvent.args.originToken,
      quoteTimestamp: depositEvent.args.quoteTimestamp,
    };

    return this.configStoreClient.computeRealizedLpFeePct(deposit, hubPoolClient.getL1TokenForDeposit(deposit));
  }

  private getDestinationTokenForDeposit(deposit: {
    originChainId: number;
    originToken: string;
    destinationChainId: number;
  }): string {
    const hubPoolClient = this.hubPoolClient();
    if (!hubPoolClient) {
      return ZERO_ADDRESS;
    } // If there is no rate model client return address(0).
    return hubPoolClient.getDestinationTokenForDeposit(deposit);
  }

  private log(level: DefaultLogLevels, message: string, data?: AnyObject) {
    this.logger[level]({ at: "SpokePoolClient", chainId: this.chainId, message, ...data });
  }
}
