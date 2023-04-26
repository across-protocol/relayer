import { groupBy } from "lodash";
import {
  spreadEvent,
  assign,
  Contract,
  BigNumber,
  EventSearchConfig,
  Promise,
  Event,
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
  RelayerRefundExecutionWithBlock,
  RootBundleRelayWithBlock,
  SpeedUp,
  TokensBridged,
  FundsDepositedEvent,
} from "../interfaces";
import { HubPoolClient } from ".";

export type SpokePoolUpdate = {
  success: boolean;
  currentTime: number;
  firstDepositId: number;
  latestBlockNumber: number;
  latestDepositId: number;
  events: Event[][];
  searchEndBlock: number;
};

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
  "message",
] as const;

export class SpokePoolClient {
  private currentTime = 0;
  private depositHashes: { [depositHash: string]: DepositWithBlock } = {};
  private depositHashesToFills: { [depositHash: string]: FillWithBlock[] } = {};
  private speedUps: { [depositorAddress: string]: { [depositId: number]: SpeedUp[] } } = {};
  private depositRoutes: { [originToken: string]: { [DestinationChainId: number]: boolean } } = {};
  private tokensBridged: TokensBridged[] = [];
  private rootBundleRelays: RootBundleRelayWithBlock[] = [];
  private relayerRefundExecutions: RelayerRefundExecutionWithBlock[] = [];
  private earlyDeposits: FundsDepositedEvent[] = [];
  private queryableEventNames: string[] = [];
  public earliestDepositIdQueried = Number.MAX_SAFE_INTEGER;
  public latestDepositIdQueried = 0;
  public firstDepositIdForSpokePool = Number.MAX_SAFE_INTEGER;
  public lastDepositIdForSpokePool = Number.MAX_SAFE_INTEGER;
  public isUpdated = false;
  public firstBlockToSearch: number;
  public latestBlockNumber = 0;
  public deposits: { [DestinationChainId: number]: DepositWithBlock[] } = {};
  public fills: { [OriginChainId: number]: FillWithBlock[] } = {};
  public refundRequests: RefundRequestWithBlock[] = [];

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    // Can be excluded. This disables some deposit validation.
    readonly configStoreClient: AcrossConfigStoreClient | null,
    readonly chainId: number,
    public deploymentBlock: number,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.queryableEventNames = Object.keys(this._queryableEventNames());
  }

  _queryableEventNames(): { [eventName: string]: EventFilter } {
    return {
      FundsDeposited: this.spokePool.filters.FundsDeposited(),
      RequestedSpeedUpDeposit: this.spokePool.filters.RequestedSpeedUpDeposit(),
      FilledRelay: this.spokePool.filters.FilledRelay(),
      // This is a hack for now but leave disabled until we need it, and until after certain bots like
      // Finalizer needs to keep reading from deprecated SpokePool, that is missing this event signature.
      // RefundRequested: this.spokePool.filters.refundRequested(),
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
    return this.rootBundleRelays.length > 0
      ? this.rootBundleRelays[this.rootBundleRelays.length - 1]?.rootBundleId + 1
      : 0;
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

    // We assume that the depositor authorises SpeedUps in isolation of each other, which keeps the relayer
    // logic simple: find the SpeedUp with the highest relayerFeePct, and use all of its fields
    if (!maxSpeedUp || maxSpeedUp.newRelayerFeePct.lte(deposit.relayerFeePct)) {
      return deposit;
    }

    // Return deposit with updated params from the speedup with the highest updated relayer fee pct.
    return {
      ...deposit,
      speedUpSignature: maxSpeedUp.depositorSignature,
      newRelayerFeePct: maxSpeedUp.newRelayerFeePct,
      updatedRecipient: maxSpeedUp.updatedRecipient,
      updatedMessage: maxSpeedUp.updatedMessage,
    };
  }

  getDepositForFill(fill: Fill): DepositWithBlock | undefined {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const depositWithMatchingDepositId = this.depositHashes[this.getDepositHash(fill)];
    if (depositWithMatchingDepositId === undefined) {
      return undefined;
    }
    return this.validateFillForDeposit(fill, depositWithMatchingDepositId) ? depositWithMatchingDepositId : undefined;
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

  // We want to find the block range that satisfies these conditions:
  // - the low block has deposit count <= targetDepositId
  // - the high block has a deposit count > targetDepositId.
  // This way the caller can search for a FundsDeposited event between [low, high] that will always
  // contain the event emitted when deposit ID was incremented to targetDepositId + 1. This is the same transaction
  // where the deposit with deposit ID = targetDepositId was created.
  async _getBlockRangeForDepositId(
    targetDepositId: number,
    initLow: number,
    initHigh: number,
    maxSearches: number
  ): Promise<{
    low: number;
    high: number;
  }> {
    assert(initLow <= initHigh, "Binary search failed because low > high");
    assert(maxSearches > 0, "maxSearches must be > 0");
    let low = initLow;
    let high = initHigh;
    let i = 0;
    do {
      const mid = Math.floor((high + low) / 2);
      const searchedDepositId = await this._getDepositIdAtBlock(mid);
      if (!Number.isInteger(searchedDepositId)) {
        throw new Error("Invalid deposit count");
      }

      // Caller can set maxSearches to minimize number of binary searches and eth_call requests.
      if (i++ >= maxSearches) {
        return { low, high };
      }

      // Since the deposit ID can jump by more than 1 in a block (e.g. if multiple deposits are sent
      // in the same block), we need to search inclusively on on the low and high, instead of the
      // traditional binary search where we set high to mid - 1 and low to mid + 1. This makes sure we
      // don't accidentally skip over mid which contains multiple deposit ID's.
      if (targetDepositId > searchedDepositId) {
        low = mid;
      } else if (targetDepositId < searchedDepositId) {
        high = mid;
      } else {
        return { low, high };
      }
    } while (low <= high);
    throw new Error("Failed to find deposit ID");
  }

  async _getDepositIdAtBlock(blockTag: number): Promise<number> {
    return await this.spokePool.numberOfDeposits({ blockTag });
  }

  // Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
  // This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
  // of a deposit older or younger than its fixed lookback.
  async queryHistoricalDepositForFill(fill: Fill): Promise<DepositWithBlock | undefined> {
    const start = Date.now();
    if (fill.originChainId !== this.chainId) {
      throw new Error("fill.originChainId !== this.chainid");
    }

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
      // Binary search for block where SpokePool.numberOfDeposits incremented to fill.depositId + 1.
      // This way we can get the blocks before and after the deposit with deposit ID = fill.depositId
      // and use those blocks to optimize the search for that deposit. Stop searches after a maximum
      // # of searches to limit number of eth_call requests. Make an eth_getLogs call on the remaining block range
      // (i.e. the [low, high] remaining from the binary search) to find the target deposit ID.
      // @dev Limiting between 5-10 searches empirically performs best when there are ~300,000 deposits
      // for a spoke pool and we're looking for a deposit <5 days older than HEAD.
      const searchBounds = await this._getBlockRangeForDepositId(
        fill.depositId + 1,
        this.deploymentBlock,
        this.latestBlockNumber,
        7
      );
      const query = await paginatedEventQuery(
        this.spokePool,
        this.spokePool.filters.FundsDeposited(
          null,
          null,
          fill.destinationChainId,
          null,
          fill.depositId,
          null,
          null,
          null,
          fill.depositor,
          null
        ),
        {
          fromBlock: searchBounds.low,
          toBlock: searchBounds.high,
          maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
        }
      );
      const event = (query as FundsDepositedEvent[]).find((deposit) => deposit.args.depositId === fill.depositId);
      if (event === undefined) {
        const srcChain = getNetworkName(fill.originChainId);
        const dstChain = getNetworkName(fill.destinationChainId);
        throw new Error(
          `Could not find deposit ${fill.depositId} for ${dstChain} fill` +
            ` between ${srcChain} blocks [${searchBounds.low}, ${searchBounds.high}]`
        );
      }
      const partialDeposit = spreadEventWithBlockNumber(event) as DepositWithBlock;
      const { realizedLpFeePct, quoteBlock: quoteBlockNumber } = await this.computeRealizedLpFeePct(event); // Append the realizedLpFeePct.
      // Append destination token and realized lp fee to deposit.
      deposit = {
        ...partialDeposit,
        realizedLpFeePct,
        destinationToken: this.getDestinationTokenForDeposit(partialDeposit),
        quoteBlockNumber,
      };
      this.logger.debug({
        at: "SpokePoolClient#queryHistoricalDepositForFill",
        message: "Queried RPC for deposit outside SpokePoolClient's search range",
        deposit,
        elapsedMs: Date.now() - start,
      });
      if (redisClient) {
        await setDeposit(deposit, getCurrentTime(), redisClient, 24 * 60 * 60);
      }
    }

    return this.validateFillForDeposit(fill, deposit) ? deposit : undefined;
  }

  async queryHistoricalMatchingFills(fill: Fill, deposit: Deposit, toBlock: number): Promise<FillWithBlock[]> {
    const searchConfig = {
      fromBlock: this.deploymentBlock,
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
        undefined, // amount
        undefined, // totalFilledAmount
        undefined, // fillAmount
        undefined, // repaymentChainId
        matchingFill.originChainId, // originChainId
        undefined, // destinationChainId
        undefined, // relayerFeePct
        undefined, // realizedLpFeePct
        matchingFill.depositId, // depositId
        undefined, // destinationToken
        undefined, // relayer
        matchingFill.depositor, // depositor
        undefined, // recipient
        undefined, // message
        undefined // updatableRelayData
      ),
      searchConfig
    );
    const fills = query.map((event) => spreadEventWithBlockNumber(event) as FillWithBlock);
    return sortEventsAscending(fills.filter((_fill) => filledSameDeposit(_fill, matchingFill)));
  }

  protected async _update(eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    // Find the earliest known depositId. This assumes no deposits were placed in the deployment block.
    let firstDepositId: number = this.firstDepositIdForSpokePool;
    if (firstDepositId === Number.MAX_SAFE_INTEGER) {
      firstDepositId = await this.spokePool.numberOfDeposits({ blockTag: this.deploymentBlock });
      if (isNaN(firstDepositId) || firstDepositId < 0) {
        throw new Error(`SpokePoolClient::update: Invalid first deposit id (${firstDepositId})`);
      }
    }

    const [latestBlockNumber, currentTime] = await Promise.all([
      this.spokePool.provider.getBlockNumber(),
      this.spokePool.getCurrentTime(),
    ]);
    if (isNaN(latestBlockNumber) || latestBlockNumber < this.latestBlockNumber) {
      throw new Error(`SpokePoolClient::update: latestBlockNumber ${latestBlockNumber} < ${this.latestBlockNumber}`);
    } else if (!BigNumber.isBigNumber(currentTime) || currentTime < toBN(this.currentTime)) {
      const errMsg = BigNumber.isBigNumber(currentTime)
        ? `currentTime: ${currentTime} < ${toBN(this.currentTime)}`
        : `currentTime is not a BigNumber: ${JSON.stringify(currentTime)}`;
      throw new Error(`SpokePoolClient::update: ${errMsg}`);
    }

    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    if (searchConfig.fromBlock > searchConfig.toBlock) {
      this.log("warn", "Invalid update() searchConfig.", { searchConfig });
      return {
        success: false,
        currentTime: this.currentTime,
        firstDepositId,
        latestBlockNumber: this.latestBlockNumber,
        latestDepositId: this.latestDepositIdQueried,
        searchEndBlock: searchConfig.fromBlock - 1,
        events: [],
      };
    }

    const eventSearchConfigs = eventsToQuery.map((eventName) => {
      if (!this.queryableEventNames.includes(eventName)) {
        throw new Error(`SpokePoolClient: Cannot query unrecognised SpokePool event name: ${eventName}`);
      }

      const _searchConfig = { ...searchConfig }; // shallow copy

      // By default, an event's query range is controlled by the `eventSearchConfig` passed in during instantiation.
      // However, certain events have special overriding requirements to their search ranges:
      // - EnabledDepositRoute: The full history is always required, so override the requested fromBlock.
      if (eventName === "EnabledDepositRoute" && !this.isUpdated) {
        _searchConfig.fromBlock = this.deploymentBlock;
      }

      return {
        filter: this._queryableEventNames()[eventName],
        searchConfig: _searchConfig,
      };
    });

    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      eventsToQuery,
      searchConfig,
      spokePool: this.spokePool.address,
    });

    const timerStart = Date.now();
    const [latestDepositId, ...events] = await Promise.all([
      this.spokePool.numberOfDeposits(),
      ...eventSearchConfigs.map((config) => paginatedEventQuery(this.spokePool, config.filter, config.searchConfig)),
    ]);
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`);

    // Sort all events to ensure they are stored in a consistent order.
    events.forEach((events: Event[]) => sortEventsAscendingInPlace(events));

    return {
      success: true,
      currentTime: currentTime.toNumber(), // uint32
      firstDepositId,
      latestBlockNumber,
      latestDepositId,
      searchEndBlock: searchConfig.toBlock,
      events,
    };
  }

  async update(eventsToQuery = this.queryableEventNames): Promise<void> {
    if (this.configStoreClient !== null && !this.configStoreClient.isUpdated) {
      throw new Error("RateModel not updated");
    }

    const { events: queryResults, currentTime, ...update } = await this._update(eventsToQuery);
    if (!update.success) {
      // This failure only occurs if the RPC searchConfig is miscomputed, and has only been seen in the hardhat test
      // environment. Normal failures will throw instead. This is therefore an unfortunate workaround until we can
      // understand why we see this in test. @todo: Resolve.
      return;
    }

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
        if (depositEvent.args.quoteTimestamp > currentTime) {
          const { args, transactionHash } = depositEvent;
          this.logger.debug({
            at: "SpokePoolClient#update",
            message: "Deferring early deposit event.",
            currentTime,
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
        const partialDeposit = spreadEventWithBlockNumber(event) as DepositWithBlock;

        // Append destination token and realized lp fee to deposit.
        const deposit: DepositWithBlock = {
          ...partialDeposit,
          realizedLpFeePct: dataForQuoteTime[index].realizedLpFeePct,
          destinationToken: this.getDestinationTokenForDeposit(partialDeposit),
          quoteBlockNumber: dataForQuoteTime[index].quoteBlock,
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
        const { recipient, message, relayerFeePct, isSlowRelay, payoutAdjustmentPct } = fill.updatableRelayData;
        // speadEventWithBlockNumber() doesn't recurse down into Objects within event.args.
        // Unpack updatableRelayData here and perform the necessary type conversions.
        fill.updatableRelayData = {
          recipient,
          message,
          isSlowRelay,
          relayerFeePct: toBN(relayerFeePct),
          payoutAdjustmentPct: toBN(payoutAdjustmentPct),
        };
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

    // Next iteration should start off from where this one ended.
    this.currentTime = currentTime;
    this.firstDepositIdForSpokePool = update.firstDepositId;
    this.latestBlockNumber = update.latestBlockNumber;
    this.lastDepositIdForSpokePool = update.latestDepositId;
    this.firstBlockToSearch = update.searchEndBlock + 1;
    this.isUpdated = true;
    this.log("debug", `SpokePool client for chain ${this.chainId} updated!`, {
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

  private getDestinationTokenForDeposit(deposit: DepositWithBlock): string {
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
