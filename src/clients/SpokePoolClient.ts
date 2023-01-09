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
  getDeploymentBlockNumber,
  getDeposit,
  setDeposit,
  getRedisDepositKey,
  assert,
  filledSameDeposit,
  sortEventsAscending,
} from "../utils";
import { toBN, ZERO_ADDRESS, winston, paginatedEventQuery, spreadEventWithBlockNumber } from "../utils";

import { AcrossConfigStoreClient } from "./ConfigStoreClient";
import {
  Deposit,
  DepositWithBlock,
  Fill,
  SpeedUp,
  FillWithBlock,
  TokensBridged,
  FundsDepositedEvent,
} from "../interfaces/SpokePool";
import { RootBundleRelayWithBlock, RelayerRefundExecutionWithBlock } from "../interfaces/SpokePool";

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
  private depositHashes: { [depositHash: string]: DepositWithBlock } = {};
  private depositHashesToFills: { [depositHash: string]: FillWithBlock[] } = {};
  private speedUps: { [depositorAddress: string]: { [depositId: number]: SpeedUp[] } } = {};
  private depositRoutes: { [originToken: string]: { [DestinationChainId: number]: boolean } } = {};
  private tokensBridged: TokensBridged[] = [];
  private rootBundleRelays: RootBundleRelayWithBlock[] = [];
  private relayerRefundExecutions: RelayerRefundExecutionWithBlock[] = [];
  public earliestDepositIdQueried = Number.MAX_SAFE_INTEGER;
  public firstDepositIdForSpokePool = Number.MAX_SAFE_INTEGER;
  public isUpdated = false;
  public firstBlockToSearch: number;
  public firstBlockSearched: number;
  public latestBlockNumber: number | undefined;
  public deposits: { [DestinationChainId: number]: DepositWithBlock[] } = {};
  public fills: { [OriginChainId: number]: FillWithBlock[] } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    // Can be excluded. This disables some deposit validation.
    readonly configStoreClient: AcrossConfigStoreClient | null,
    readonly chainId: number,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    public spokePoolDeploymentBlock?: number
  ) {
    this.spokePoolDeploymentBlock =
      spokePoolDeploymentBlock === undefined
        ? getDeploymentBlockNumber("SpokePool", chainId)
        : spokePoolDeploymentBlock;
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
  }

  _queryableEventNames(): { [eventName: string]: EventFilter } {
    return {
      FundsDeposited: this.spokePool.filters.FundsDeposited(),
      RequestedSpeedUpDeposit: this.spokePool.filters.RequestedSpeedUpDeposit(),
      FilledRelay: this.spokePool.filters.FilledRelay(),
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

  getRootBundleRelays() {
    return this.rootBundleRelays;
  }

  getRelayerRefundExecutions() {
    return this.relayerRefundExecutions;
  }

  getExecutedRefunds(relayerRefundRoot: string) {
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
      if (executedRefunds[tokenAddress] === undefined) executedRefunds[tokenAddress] = {};
      const executedTokenRefunds = executedRefunds[tokenAddress];

      for (let i = 0; i < refundLeaf.refundAddresses.length; i++) {
        const relayer = refundLeaf.refundAddresses[i];
        const refundAmount = refundLeaf.refundAmounts[i];
        if (executedTokenRefunds[relayer] === undefined) executedTokenRefunds[relayer] = BigNumber.from(0);
        executedTokenRefunds[relayer] = executedTokenRefunds[relayer].add(refundAmount);
      }
    }
    return executedRefunds;
  }

  appendMaxSpeedUpSignatureToDeposit(deposit: DepositWithBlock) {
    const maxSpeedUp = this.speedUps[deposit.depositor]?.[deposit.depositId]?.reduce((prev, current) =>
      prev.newRelayerFeePct.gt(current.newRelayerFeePct) ? prev : current
    );

    // Only if there is a speedup and the new relayer fee is greater than the current relayer fee, save the new fee.
    if (!maxSpeedUp || maxSpeedUp.newRelayerFeePct.lte(deposit.relayerFeePct)) return deposit;
    return {
      ...deposit,
      speedUpSignature: maxSpeedUp.depositorSignature,
      newRelayerFeePct: maxSpeedUp.newRelayerFeePct,
    };
  }

  getDepositForFill(fill: Fill): DepositWithBlock | undefined {
    const { blockNumber, ...fillCopy } = fill as FillWithBlock; // Ignore blockNumber when validating the fill.
    const depositWithMatchingDepositId = this.depositHashes[this.getDepositHash(fill)];
    if (depositWithMatchingDepositId === undefined) return undefined;
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
        if (this.validateFillForDeposit(fill, deposit)) groupedFills.validFills.push(fill);
        else groupedFills.invalidFills.push(fill);
        return groupedFills;
      },
      { validFills: [], invalidFills: [] }
    );

    // Log any invalid deposits with same deposit id but different params.
    const invalidFillsForDeposit = invalidFills.filter((x) => x.depositId === deposit.depositId);
    if (invalidFillsForDeposit.length > 0)
      this.logger.warn({
        at: "SpokePoolClient",
        chainId: this.chainId,
        message: "Invalid fills found matching deposit ID",
        deposit,
        invalidFills: Object.fromEntries(invalidFillsForDeposit.map((x) => [x.relayer, x])),
      });

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

  getDepositHash(event: Deposit | Fill) {
    return `${event.depositId}-${event.originChainId}`;
  }

  // Look for the block number of the event that emitted the deposit with the target deposit ID. We know that
  // `numberOfDeposits` is strictly increasing for any SpokePool, so we can use a binary search to find the blockTag
  // where `numberOfDeposits == targetDepositId`.
  async binarySearchForBlockContainingDepositId(
    targetDepositId: number,
    initLow = this.spokePoolDeploymentBlock,
    initHigh = this.eventSearchConfig.fromBlock
  ): Promise<number> {
    assert(initLow <= initHigh, "Binary search failed because low > high");
    let low = initLow;
    let high = initHigh;
    do {
      const mid = Math.floor((high + low) / 2);
      const searchedDepositId = await this.spokePool.numberOfDeposits({ blockTag: mid });
      if (targetDepositId > searchedDepositId) low = mid + 1;
      else if (targetDepositId < searchedDepositId) high = mid - 1;
      else return mid;
    } while (low <= high);
    // If we can't find a blockTag where `numberOfDeposits == targetDepositId`,
    // then its likely that the depositId was included in the same block as deposits that came after it. So we fallback
    // to returning `low` if we exit the while loop, which should be the block where depositId incremented from
    // `targetDepositId`.
    return low;
  }

  // Load a deposit for a fill if the fill's deposit ID is less than this client's earliest searched
  // deposit ID. This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
  // of a deposit older than its fixed lookback.
  async queryHistoricalDepositForFill(fill: Fill): Promise<DepositWithBlock | undefined> {
    if (fill.originChainId !== this.chainId) throw new Error("fill.originChainId !== this.chainid");

    // We need to update client so that we know what the firstDepositIdForSpokePool is and the
    // earliestDepositIdQueried is so that we can exit early.
    if (!this.isUpdated) throw new Error("SpokePoolClient must be updated before querying historical deposits");
    if (fill.depositId < this.firstDepositIdForSpokePool) return undefined;
    if (fill.depositId >= this.earliestDepositIdQueried) return this.getDepositForFill(fill);

    let deposit: DepositWithBlock, cachedDeposit: Deposit | undefined;
    if (this.configStoreClient.redisClient) {
      cachedDeposit = await getDeposit(getRedisDepositKey(fill), this.configStoreClient.redisClient);
    }
    if (cachedDeposit) {
      deposit = cachedDeposit as DepositWithBlock;
      // Assert that cache hasn't been corrupted.
      assert(deposit.depositId === fill.depositId && deposit.originChainId === fill.originChainId);
    } else {
      // Binary search between spoke pool deployment block and earliest block searched to find the block range containing
      // the deposited event. Find a block before and after the deposit event, which was emitted when
      // depositId incremented from fill.depositId to fill.depositId+1
      const [blockBeforeDeposit, blockAfterDeposit] = await Promise.all([
        // Look for the block where depositId incremented from fill.depositId-1 to fill.depositId.
        this.binarySearchForBlockContainingDepositId(fill.depositId),
        // Look for the block where depositId incremented from fill.depositId to fill.depositId+1.
        this.binarySearchForBlockContainingDepositId(fill.depositId + 1),
      ]);
      assert(blockBeforeDeposit <= blockAfterDeposit, "blockBeforeDeposit > blockAfterDeposit");

      const query = await paginatedEventQuery(
        this.spokePool,
        // TODO: When SpokePool V2 is deployed we can begin to filter on fill.depositId as well as fill.depositor,
        // which should optimize the RPC request.
        this.spokePool.filters.FundsDeposited(null, null, null, null, null, null, null, null, fill.depositor),
        {
          fromBlock: blockBeforeDeposit,
          toBlock: blockAfterDeposit,
          maxBlockLookBack: 0,
        }
      );
      const event = (query as FundsDepositedEvent[]).find((deposit) => deposit.args.depositId === fill.depositId);
      if (event === undefined)
        throw new Error(
          `Could not find deposit ID ${fill.depositId} for fill between blocks [${blockBeforeDeposit}, ${blockAfterDeposit}]`
        );
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
        message: "Queried RPC for deposit older than SpokePoolClient's lookback",
        deposit,
      });
      if (this.configStoreClient.redisClient)
        await setDeposit(deposit, this.configStoreClient.redisClient, 30 * 24 * 60 * 60);
    }

    const { blockNumber, ...fillCopy } = fill as FillWithBlock; // Ignore blockNumber when validating the fill
    return this.validateFillForDeposit(fillCopy, deposit) ? deposit : undefined;
  }

  async queryHistoricalMatchingFills(fill: Fill, toBlock: number) {
    const searchConfig = {
      fromBlock: getDeploymentBlockNumber("SpokePool", this.chainId),
      toBlock,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    return await this.queryFillsInBlockRange(fill, searchConfig);
  }

  async queryFillsInBlockRange(matchingFill: Fill, searchConfig: EventSearchConfig) {
    // Filtering on the fill's depositor address, the only indexed deposit field in the FilledRelay event,
    // should speed up this search a bit.
    // TODO: Once depositId is indexed in FilledRelay event, filter on that as well.
    const query = await paginatedEventQuery(
      this.spokePool,
      this.spokePool.filters.FilledRelay(matchingFill.depositor),
      searchConfig
    );
    const fills = query.map((event) => spreadEventWithBlockNumber(event) as FillWithBlock);
    return sortEventsAscending(fills.filter((_fill) => filledSameDeposit(_fill, matchingFill)));
  }

  async update(eventsToQuery?: string[]) {
    if (this.configStoreClient !== null && !this.configStoreClient.isUpdated) throw new Error("RateModel not updated");
    const { NODE_MAX_CONCURRENCY } = process.env;
    // Default to a max concurrency of 1000 requests per node.
    const nodeMaxConcurrency = Number(
      process.env[`NODE_MAX_CONCURRENCY_${this.chainId}`] || NODE_MAX_CONCURRENCY || "1000"
    );

    // Require that all Deposits meet the minimum specified number of confirmations.
    this.latestBlockNumber = await this.spokePool.provider.getBlockNumber();
    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || this.latestBlockNumber,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };

    // Deposit route search config should always go from the deployment block to ensure we fetch all routes. If this is
    // the first run then set the from block to the deployment block of the spoke pool. Else, use the same config as the
    // other event queries to not double search over the same event ranges.
    const depositRouteSearchConfig = { ...searchConfig }; // shallow copy.
    if (!this.isUpdated) depositRouteSearchConfig.fromBlock = this.spokePoolDeploymentBlock;

    if (searchConfig.fromBlock > searchConfig.toBlock) return; // If the starting block is greater than the ending block return.

    // Try to reduce the number of web3 requests sent to query FundsDeposited and FilledRelay events since there are
    // expected to be so many. We will first try to load existing cached events if they exist and if they do, then
    // we only need to search for new events after the last cached event searched. We will then update the cache with
    // all blocks (cached + newly fetched) older than the "latestBlockToCache".
    const depositEventSearchConfig = { ...searchConfig };

    let timerStart = Date.now();

    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      searchConfig,
      depositRouteSearchConfig,
      depositEventSearchConfig,
      spokePool: this.spokePool.address,
    });

    // If caller specifies which events to query, then only query those. This can be used by bots to limit web3
    // requests. Otherwise, default to looking up all events.
    if (eventsToQuery === undefined) eventsToQuery = Object.keys(this._queryableEventNames());
    const eventSearchConfigs = eventsToQuery.map((eventName) => {
      if (!Object.keys(this._queryableEventNames()).includes(eventName))
        throw new Error("Unknown event to query in SpokePoolClient");
      // By default, an event's query range can be overridden (usually shortened) by the `eventSearchConfig`
      // passed in to the Config object. However, certain types of have special rules that could change their
      // search ranges:
      let searchConfigToUse = searchConfig;
      // These events always are queried from when Across' spoke pools were first deployed.
      if (eventName === "EnabledDepositRoute") searchConfigToUse = depositRouteSearchConfig;
      // These events can be loaded from the `cachedData` so they use a potentially modified `depositEventSearchConfig`.
      else if (eventName === "FundsDeposited" || eventName === "FilledRelay")
        searchConfigToUse = depositEventSearchConfig;

      return {
        filter: this._queryableEventNames()[eventName],
        searchConfig: searchConfigToUse,
      };
    });

    timerStart = Date.now();
    const [_earliestDepositIdForSpokePool, ...queryResults] = await Promise.all([
      this.spokePool.numberOfDeposits({ blockTag: this.spokePoolDeploymentBlock }),
      ...eventSearchConfigs.map((config) => paginatedEventQuery(this.spokePool, config.filter, config.searchConfig)),
    ]);

    this.firstDepositIdForSpokePool = _earliestDepositIdForSpokePool;
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart}ms`);

    // Sort all events to ensure they are stored in a consistent order.
    queryResults.forEach((events) => {
      sortEventsAscendingInPlace(events);
    });

    if (eventsToQuery.includes("TokensBridged"))
      for (const event of queryResults[eventsToQuery.indexOf("TokensBridged")]) {
        this.tokensBridged.push(spreadEventWithBlockNumber(event) as TokensBridged);
      }

    // For each depositEvent, compute the realizedLpFeePct. Note this means that we are only finding this value on the
    // new deposits that were found in the searchConfig (new from the previous run). This is important as this operation
    // is heavy as there is a fair bit of block number lookups that need to happen. Note this call REQUIRES that the
    // hubPoolClient is updated on the first before this call as this needed the the L1 token mapping to each L2 token.
    if (eventsToQuery.includes("FundsDeposited")) {
      const depositEvents = queryResults[eventsToQuery.indexOf("FundsDeposited")] as FundsDepositedEvent[];
      if (depositEvents.length > 0)
        this.log("debug", `Fetching realizedLpFeePct for ${depositEvents.length} deposits on chain ${this.chainId}`, {
          numDeposits: depositEvents.length,
        });
      const dataForQuoteTime: { realizedLpFeePct: BigNumber; quoteBlock: number }[] = await Promise.map(
        depositEvents,
        async (event) => {
          return this.computeRealizedLpFeePct(event);
        },
        { concurrency: nodeMaxConcurrency }
      );

      // Now add any newly fetched events from RPC.
      if (depositEvents.length > 0)
        this.log("debug", `Using ${depositEvents.length} newly queried deposit events for chain ${this.chainId}`, {
          earliestEvent: depositEvents[0].blockNumber,
        });
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

        if (deposit.depositId < this.earliestDepositIdQueried) this.earliestDepositIdQueried = deposit.depositId;
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
      for (const [_destinationChainId, deposits] of Object.entries(this.deposits)) {
        for (const [index, deposit] of deposits.entries()) {
          deposits[index] = this.appendMaxSpeedUpSignatureToDeposit(deposit);
        }
      }
    }

    if (eventsToQuery.includes("FilledRelay")) {
      const fillEvents = queryResults[eventsToQuery.indexOf("FilledRelay")];

      if (fillEvents.length > 0)
        this.log("debug", `Using ${fillEvents.length} newly queried fill events for chain ${this.chainId}`, {
          earliestEvent: fillEvents[0].blockNumber,
        });
      for (const event of fillEvents) {
        const fill = spreadEventWithBlockNumber(event) as FillWithBlock;
        assign(this.fills, [fill.originChainId], [fill]);
        assign(this.depositHashesToFills, [this.getDepositHash(fill)], [fill]);
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
      searchConfig,
      depositRouteSearchConfig,
      depositEventSearchConfig,
      nextFirstBlockToSearch: this.firstBlockToSearch,
    });
  }

  static getExecutedRefundLeafL2Token(chainId: number, eventL2Token: string) {
    // If execution of WETH refund leaf occurred on an OVM spoke pool, then we'll convert its l2Token from the native
    // token address to the wrapped token address. This is because the OVM_SpokePool modifies the l2TokenAddress prop
    // in _bridgeTokensToHubPool before emitting the ExecutedRelayerRefundLeaf event.
    // Here is the contract code referenced:
    // - https://github.com/across-protocol/contracts-v2/blob/954528a4620863d1c868e54a370fd8556d5ed05c/contracts/Ovm_SpokePool.sol#L142
    if (chainId === 10 && eventL2Token.toLowerCase() === "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000")
      return "0x4200000000000000000000000000000000000006";
    else if (chainId === 288 && eventL2Token.toLowerCase() === "0x4200000000000000000000000000000000000006")
      return "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000";
    else return eventL2Token;
  }

  public hubPoolClient() {
    return this.configStoreClient?.hubPoolClient;
  }

  private async computeRealizedLpFeePct(depositEvent: FundsDepositedEvent) {
    const hubPoolClient = this.hubPoolClient();
    if (!hubPoolClient || !this.configStoreClient) return { realizedLpFeePct: toBN(0), quoteBlock: 0 }; // If there is no rate model client return 0.
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
    if (!hubPoolClient) return ZERO_ADDRESS; // If there is no rate model client return address(0).
    return hubPoolClient.getDestinationTokenForDeposit(deposit);
  }

  private log(level: DefaultLogLevels, message: string, data?: any) {
    this.logger[level]({ at: "SpokePoolClient", chainId: this.chainId, message, ...data });
  }
}
