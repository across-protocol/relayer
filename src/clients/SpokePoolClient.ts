import assert from "assert";
import {
  spreadEvent,
  assign,
  Contract,
  BigNumber,
  EventSearchConfig,
  Promise,
  EventFilter,
  getFromCache,
  setInCache,
  CachedDepositData,
  CachedFillData,
  CachedData,
  DepositWithBlockInCache,
  FillWithBlockInCache,
} from "../utils";
import {
  toBN,
  Event,
  ZERO_ADDRESS,
  winston,
  cachedPaginatedEventQuery,
  spreadEventWithBlockNumber,
  EventCache,
} from "../utils";

import { AcrossConfigStoreClient } from "./ConfigStoreClient";
import {
  Deposit,
  DepositWithBlock,
  Fill,
  SpeedUp,
  FillWithBlock,
  TokensBridged,
  SortableEvent,
  RootBundleRelayWithBlock,
  RelayerRefundExecutionWithBlock,
} from "../interfaces";

export class SpokePoolClient {
  private deposits: { [DestinationChainId: number]: Deposit[] } = {};
  private depositHashes: { [depositHash: string]: Deposit } = {};
  private fills: Fill[] = [];
  private depositHashesToFills: { [depositHash: string]: Fill[] } = {};
  private speedUps: { [depositorAddress: string]: { [depositId: number]: SpeedUp[] } } = {};
  private depositRoutes: { [originToken: string]: { [DestinationChainId: number]: boolean } } = {};
  private tokensBridged: TokensBridged[] = [];
  private rootBundleRelays: RootBundleRelayWithBlock[] = [];
  private relayerRefundExecutions: RelayerRefundExecutionWithBlock[] = [];
  private eventCaches: Record<string, EventCache>;
  public isUpdated = false;
  public firstBlockToSearch: number;
  public latestBlockNumber: number;
  public fillsWithBlockNumbers: FillWithBlock[] = [];
  public depositsWithBlockNumbers: { [DestinationChainId: number]: DepositWithBlock[] } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    readonly configStoreClient: AcrossConfigStoreClient | null, // Can be excluded. This disables some deposit validation.
    readonly chainId: number,
    readonly eventSearchConfig: EventSearchConfig = { fromBlock: 0, toBlock: null, maxBlockLookBack: 0 },
    readonly spokePoolDeploymentBlock: number = 0
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.eventCaches = this.initEventCaches();
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
  // create unique event cache for each event type since each type is queried independently
  private initEventCaches(): Record<string, EventCache> {
    const eventNames = this._queryableEventNames();
    return Object.fromEntries(
      [...Object.entries(eventNames)].map(([name, filter]) => {
        return [
          name,
          new EventCache({
            chainId: this.chainId,
            key: "spokepool",
            eventName: name,
            redisClient: this.configStoreClient.redisClient,
            eventFilter: filter,
            contract: this.spokePool,
          }),
        ];
      })
    );
  }
  private getEventCache(eventName: string): EventCache {
    const eventCache = this.eventCaches[eventName];
    assert(eventCache, "No cache for event name: " + eventName);
    return eventCache;
  }
  getDepositsForDestinationChain(destinationChainId: number, withBlock = false): Deposit[] | DepositWithBlock[] {
    return withBlock
      ? this.depositsWithBlockNumbers[destinationChainId] || []
      : this.deposits[destinationChainId] || [];
  }

  getDepositsFromDepositor(depositor: string): Deposit[] {
    return Object.values(this.deposits)
      .flat()
      .filter((deposit: Deposit) => deposit.depositor === depositor); // Select only deposits where the depositor is the same.
  }

  getFills(): Fill[] {
    return this.fills;
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

  getFillsForOriginChain(originChainId: number): Fill[] {
    return this.fills.filter((fill: Fill) => fill.originChainId === originChainId);
  }

  getFillsWithBlockForOriginChain(originChainId: number): FillWithBlock[] {
    return this.fillsWithBlockNumbers.filter((fill: FillWithBlock) => fill.originChainId === originChainId);
  }

  getFillsWithBlockForDestinationChainAndRelayer(chainId: number, relayer: string): FillWithBlock[] {
    return this.fillsWithBlockNumbers.filter(
      (fill: FillWithBlock) => fill.relayer === relayer && fill.destinationChainId === chainId
    );
  }

  getFillsWithBlockInRange(startingBlock: number, endingBlock: number): FillWithBlock[] {
    return this.fillsWithBlockNumbers.filter(
      (fill) => fill.blockNumber >= startingBlock && fill.blockNumber <= endingBlock
    );
  }

  getFillsForRepaymentChain(repaymentChainId: number) {
    return this.fills.filter((fill: Fill) => fill.repaymentChainId === repaymentChainId);
  }

  getFillsForRelayer(relayer: string) {
    return this.fills.filter((fill: Fill) => fill.relayer === relayer);
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

  appendMaxSpeedUpSignatureToDeposit(deposit: Deposit) {
    const maxSpeedUp = this.speedUps[deposit.depositor]?.[deposit.depositId].reduce((prev, current) =>
      prev.newRelayerFeePct.gt(current.newRelayerFeePct) ? prev : current
    );

    // Only if there is a speedup and the new relayer fee is greater than the current relayer fee, replace the fee.
    if (!maxSpeedUp || maxSpeedUp.newRelayerFeePct.lte(deposit.relayerFeePct)) return deposit;
    return { ...deposit, speedUpSignature: maxSpeedUp.depositorSignature, relayerFeePct: maxSpeedUp.newRelayerFeePct };
  }

  getDepositForFill(fill: Fill): Deposit | undefined {
    const { blockNumber, ...fillCopy } = fill as FillWithBlock; // Ignore blockNumber when validating the fill.
    const depositWithMatchingDepositId = this.depositHashes[this.getDepositHash(fill)];
    if (depositWithMatchingDepositId === undefined) return undefined;
    return this.validateFillForDeposit(fillCopy, depositWithMatchingDepositId)
      ? depositWithMatchingDepositId
      : undefined;
  }

  getValidUnfilledAmountForDeposit(deposit: Deposit): { unfilledAmount: BigNumber; fillCount: number } {
    const fillsForDeposit = this.depositHashesToFills[this.getDepositHash(deposit)];
    // If no fills then the full amount is remaining.
    if (fillsForDeposit === undefined || fillsForDeposit.length === 0) {
      return { unfilledAmount: toBN(deposit.amount), fillCount: 0 };
    }
    const fills = fillsForDeposit.filter((fill) => this.validateFillForDeposit(fill, deposit));
    // If all fills are invalid we can consider this unfilled.
    if (fills.length === 0) {
      return { unfilledAmount: toBN(deposit.amount), fillCount: 0 };
    }

    // Order fills by totalFilledAmount and then return the first fill's full deposit amount minus total filled amount.
    const fillsOrderedByTotalFilledAmount = fills.sort((fillA, fillB) =>
      fillB.totalFilledAmount.gt(fillA.totalFilledAmount)
        ? 1
        : fillB.totalFilledAmount.lt(fillA.totalFilledAmount)
        ? -1
        : 0
    );

    const lastFill = fillsOrderedByTotalFilledAmount[0];
    return { unfilledAmount: toBN(lastFill.amount.sub(lastFill.totalFilledAmount)), fillCount: fills.length };
  }

  // Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
  // by the depositor as well as the realizedLpFeePct and the destinationToken, which are pulled from other clients.
  validateFillForDeposit(fill: Fill, deposit: Deposit) {
    let isValid = true;
    Object.keys(deposit).forEach((key) => {
      if (["transactionHash", "transactionIndex", "logIndex", "blockNumber"].includes(key)) return;
      if (fill[key] !== undefined && deposit[key].toString() !== fill[key].toString()) isValid = false;
    });
    return isValid;
  }

  getDepositHash(event: Deposit | Fill) {
    return `${event.depositId}-${event.originChainId}`;
  }

  // `latestBlockToCache` will inform this client which new blocks to store in the Redis cache. If this is set > 0, then
  // this function will first load all events from the cache, and then request any blocks not covered in the cache
  // from an RPC. The combined blocks will then be saved back into the cache up to `latestBlockToCache`.
  async update(eventsToQuery?: string[], latestBlockToCache = 0) {
    if (this.configStoreClient !== null && !this.configStoreClient.isUpdated) throw new Error("RateModel not updated");
    const { NODE_MAX_CONCURRENCY } = process.env;
    // Default to a max concurrency of 1000 requests per node.
    const nodeMaxConcurrency = Number(
      process.env[`NODE_MAX_CONCURRENCY_${this.chainId}`] || NODE_MAX_CONCURRENCY || "1000"
    );

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
      let searchConfigToUse = searchConfig;
      if (eventName === "EnabledDepositRoute" || eventName === "TokensBridged")
        searchConfigToUse = depositRouteSearchConfig;
      else if (eventName === "FundsDeposited" || eventName === "FilledRelay")
        searchConfigToUse = depositEventSearchConfig;

      return {
        eventName,
        filter: this._queryableEventNames()[eventName],
        searchConfig: searchConfigToUse,
      };
    });

    const queryResults = await Promise.all(
      eventSearchConfigs.map((config) =>
        cachedPaginatedEventQuery(this.getEventCache(config.eventName), config.searchConfig, latestBlockToCache)
      )
    );

    if (eventsToQuery.includes("TokensBridged"))
      for (const event of queryResults[eventsToQuery.indexOf("TokensBridged")]) {
        this.tokensBridged.push(event as TokensBridged);
      }

    // For each depositEvent, compute the realizedLpFeePct. Note this means that we are only finding this value on the
    // new deposits that were found in the searchConfig (new from the previous run). This is important as this operation
    // is heavy as there is a fair bit of block number lookups that need to happen. Note this call REQUIRES that the
    // hubPoolClient is updated on the first before this call as this needed the the L1 token mapping to each L2 token.
    if (eventsToQuery.includes("FundsDeposited")) {
      const depositEvents = queryResults[eventsToQuery.indexOf("FundsDeposited")];
      if (depositEvents.length > 0) {
        this.log("debug", `Fetching realizedLpFeePct for ${depositEvents.length} deposits on chain ${this.chainId}`, {
          numDeposits: depositEvents.length,
        });
        const dataForQuoteTime: { realizedLpFeePct: BigNumber; quoteBlock: number }[] = await Promise.map(
          depositEvents,
          async (event: DepositWithBlock) => this.computeRealizedLpFeePct(event),
          { concurrency: nodeMaxConcurrency }
        );
        // start assigning things in order
        depositEvents.forEach((event, index) => {
          const deposit: DepositWithBlock = {
            ...event,
            realizedLpFeePct: dataForQuoteTime[index].realizedLpFeePct,
            originBlockNumber: event.blockNumber,
          };
          deposit.destinationToken = this.getDestinationTokenForDeposit(deposit);
          assign(this.depositHashes, [this.getDepositHash(deposit)], deposit);
          assign(this.deposits, [deposit.destinationChainId], [deposit]);
          assign(
            this.depositsWithBlockNumbers,
            [deposit.destinationChainId],
            [{ ...deposit, blockNumber: dataForQuoteTime[index].quoteBlock }]
          );
        });
      }
    }

    if (eventsToQuery.includes("RequestedSpeedUpDeposit")) {
      const speedUpEvents = queryResults[eventsToQuery.indexOf("RequestedSpeedUpDeposit")];

      for (const event of speedUpEvents) {
        const speedUp: SpeedUp = { ...event, originChainId: this.chainId };
        assign(this.speedUps, [speedUp.depositor, speedUp.depositId], [speedUp]);
      }

      // Traverse all deposit events and update them with associated speedups, If they exist.
      for (const destinationChainId of Object.keys(this.deposits))
        for (const [index, deposit] of this.deposits[destinationChainId].entries()) {
          const speedUpDeposit = this.appendMaxSpeedUpSignatureToDeposit(deposit);
          if (speedUpDeposit !== deposit) this.deposits[destinationChainId][index] = speedUpDeposit;
        }
    }

    if (eventsToQuery.includes("FilledRelay")) {
      const fillEvents = queryResults[eventsToQuery.indexOf("FilledRelay")];
      if (fillEvents.length > 0)
        this.log("debug", `Using ${fillEvents.length} newly queried fill events for chain ${this.chainId}`, {
          earliestEvent: fillEvents[0].blockNumber,
        });
      for (const event of fillEvents) {
        this.fills.push(event);
        this.fillsWithBlockNumbers.push(event as FillWithBlock);
        assign(this.depositHashesToFills, [this.getDepositHash(event)], [event]);
      }
    }

    if (eventsToQuery.includes("EnabledDepositRoute")) {
      const enableDepositsEvents = queryResults[eventsToQuery.indexOf("EnabledDepositRoute")];

      for (const event of enableDepositsEvents) {
        const enableDeposit = event;
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
        this.rootBundleRelays.push(event as RootBundleRelayWithBlock);
      }
    }

    if (eventsToQuery.includes("ExecutedRelayerRefundRoot")) {
      const executedRelayerRefundRootEvents = queryResults[eventsToQuery.indexOf("ExecutedRelayerRefundRoot")];
      for (const event of executedRelayerRefundRootEvents) {
        const executedRefund = event as RelayerRefundExecutionWithBlock;
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
    return this.configStoreClient.hubPoolClient;
  }
  private async computeRealizedLpFeePct(depositEvent: Deposit) {
    if (!this.configStoreClient) return { realizedLpFeePct: toBN(0), quoteBlock: 0 }; // If there is no rate model client return 0.
    const deposit = {
      amount: depositEvent.amount,
      originChainId: Number(depositEvent.originChainId),
      originToken: depositEvent.originToken,
      quoteTimestamp: depositEvent.quoteTimestamp,
    } as Deposit;

    return this.configStoreClient.computeRealizedLpFeePct(deposit, this.hubPoolClient().getL1TokenForDeposit(deposit));
  }

  private getDestinationTokenForDeposit(deposit: Deposit): string {
    if (!this.configStoreClient) return ZERO_ADDRESS; // If there is no rate model client return address(0).
    return this.hubPoolClient().getDestinationTokenForDeposit(deposit);
  }

  private log(level: string, message: string, data?: any) {
    this.logger[level]({ at: "SpokePoolClient", chainId: this.chainId, message, ...data });
  }
}
