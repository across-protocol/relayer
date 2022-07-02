import { spreadEvent, assign, Contract, BigNumber, EventSearchConfig, Promise, EventFilter, sortEventsDescending, assert } from "../utils";
import { toBN, Event, ZERO_ADDRESS, winston, paginatedEventQuery, spreadEventWithBlockNumber } from "../utils";

import { AcrossConfigStoreClient } from "./ConfigStoreClient";
import { Deposit, DepositWithBlock, DepositWithBlockInCache, Fill, SpeedUp, FillWithBlock, TokensBridged } from "../interfaces/SpokePool";
import { RootBundleRelayWithBlock, RelayerRefundExecutionWithBlock } from "../interfaces/SpokePool";

interface CachedDepositData {
  latestBlock: number;
  deposits: { [destinationChainId: number]: DepositWithBlockInCache[] };
}
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
  public isUpdated: boolean = false;
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

  getDepositRoutes(): { [originToken: string]: { [DestinationChainId: number]: Boolean } } {
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
    if (fillsForDeposit === undefined || fillsForDeposit === [])
      return { unfilledAmount: toBN(deposit.amount), fillCount: 0 }; // If no fills then the full amount is remaining.
    const fills = fillsForDeposit.filter((fill) => this.validateFillForDeposit(fill, deposit));

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
      if (fill[key] !== undefined && deposit[key].toString() !== fill[key].toString()) isValid = false;
    });
    return isValid;
  }

  getDepositHash(event: Deposit | Fill) {
    return `${event.depositId}-${event.originChainId}`;
  }

  async update(eventsToQuery?: string[], endBlockForChainInLatestFullyExecutedBundle = 0) {
    if (this.configStoreClient !== null && !this.configStoreClient.isUpdated) throw new Error("RateModel not updated");

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

    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      searchConfig,
      depositRouteSearchConfig,
      spokePool: this.spokePool.address,
    });
    if (searchConfig.fromBlock > searchConfig.toBlock) return; // If the starting block is greater than the ending block return.

    // Try to reduce the number of web3 requests sent to query FundsDeposited and FilledRelay events, of which there
    // expected to be many. We will first try to load existing cached events if they exist and if they do, then
    // we only need to search for new events after the last cached event searched.
    let cachedDepositData: CachedDepositData | undefined;
    const depositEventSearchConfig = { ...searchConfig };
    if (endBlockForChainInLatestFullyExecutedBundle > 0) {
      cachedDepositData = await this.getDepositDataFromCache();
      const latestCachedBlock = cachedDepositData.latestBlock ?? 0;

      if (latestCachedBlock > 0) {
        // TODO: If `latestCachedBlock > endBlockForChainInLatestFullyExecutedBundle` there is a problem
        // TODO: If `latestCachedBlock < searchConfig.fromBlock` that's also a problem
        // We shouldn't neccessarily throw errors in these situations but just need to handle them. Can always default
        // to loading ALL events from fromBlock.
        assert(latestCachedBlock <= endBlockForChainInLatestFullyExecutedBundle)
        assert(latestCachedBlock >= depositEventSearchConfig.fromBlock)
        depositEventSearchConfig.fromBlock = latestCachedBlock + 1;
        this.log("debug", `Partially loading event data from cache for chain ${this.chainId}`, {
          latestCachedBlock,
          newSearchConfigForDepositAndFillEvents: depositEventSearchConfig,
        });
      }
    }

    // If caller specifies which events to query, then only query those. This can be used by bots to limit web3
    // requests. Otherwise, default to looking up all events.
    if (eventsToQuery === undefined) eventsToQuery = Object.keys(this._queryableEventNames());
    const eventSearchConfigs = eventsToQuery.map((eventName) => {
      if (!Object.keys(this._queryableEventNames()).includes(eventName))
        throw new Error("Unknown event to query in SpokePoolClient");
      let searchConfigToUse = searchConfig
      if (eventName === "EnabledDepositRoute" || eventName === "TokensBridged")
        searchConfigToUse = depositRouteSearchConfig;
      else if (eventName === "FundsDeposited" /* || eventName === "FilledRelay" */)
        searchConfigToUse = depositEventSearchConfig;
      return {
        filter: this._queryableEventNames()[eventName],
        searchConfig: searchConfigToUse,
      };
    });

    const queryResults = await Promise.all(
      eventSearchConfigs.map((config) => paginatedEventQuery(this.spokePool, config.filter, config.searchConfig)),
      { concurrency: 2 }
    );

    if (eventsToQuery.includes("TokensBridged"))
      for (const event of queryResults[eventsToQuery.indexOf("TokensBridged")]) {
        this.tokensBridged.push(spreadEventWithBlockNumber(event) as TokensBridged);
      }

    // For each depositEvent, compute the realizedLpFeePct. Note this means that we are only finding this value on the
    // new deposits that were found in the searchConfig (new from the previous run). This is important as this operation
    // is heavy as there is a fair bit of block number lookups that need to happen. Note this call REQUIRES that the
    // hubPoolClient is updated on the first before this call as this needed the the L1 token mapping to each L2 token.
    if (eventsToQuery.includes("FundsDeposited")) {
      const depositEvents = queryResults[eventsToQuery.indexOf("FundsDeposited")];
      if (depositEvents.length > 0)
        this.log("debug", `Fetching realizedLpFeePct for ${depositEvents.length} deposits on chain ${this.chainId}`, {
            numDeposits: depositEvents.length,
          }
        );
      const dataForQuoteTime: { realizedLpFeePct: BigNumber; quoteBlock: number }[] = await Promise.all(
        depositEvents.map((event) => this.computeRealizedLpFeePct(event))
      );

      // First populate deposits mapping with cached event data and then newly fetched data. We assume that cached
      // data always precedes newly fetched data.
      if (cachedDepositData?.deposits !== undefined) {
        for (const destinationChainId of Object.keys(cachedDepositData.deposits)) {
          console.log(
            `Loaded ${cachedDepositData.deposits[destinationChainId].length} cached deposit events for chain ${this.chainId} and destination chain ${destinationChainId}`
          );
          cachedDepositData.deposits[destinationChainId].forEach((deposit: DepositWithBlockInCache) => {
            const convertedDeposit = this.convertDepositInCache(deposit);
            assign(this.depositHashes, [this.getDepositHash(convertedDeposit)], convertedDeposit);
            assign(this.deposits, [convertedDeposit.destinationChainId], [convertedDeposit]);
            assign(this.depositsWithBlockNumbers, [convertedDeposit.destinationChainId], [convertedDeposit]);
          })
        }
      }
      for (const [index, event] of depositEvents.entries()) {
        // Append the realizedLpFeePct.
        const deposit: Deposit = { ...spreadEvent(event), realizedLpFeePct: dataForQuoteTime[index].realizedLpFeePct };
        // Append the destination token to the deposit.
        deposit.destinationToken = this.getDestinationTokenForDeposit(deposit);
        assign(this.depositHashes, [this.getDepositHash(deposit)], deposit);
        assign(this.deposits, [deposit.destinationChainId], [deposit]);
        assign(
          this.depositsWithBlockNumbers,
          [deposit.destinationChainId],
          [{ ...deposit, blockNumber: dataForQuoteTime[index].quoteBlock, originBlockNumber: event.blockNumber }]
        );
      }


      // Update cache with deposit events <= bundle end block in latest fully executed bundle for this chain.
      if (endBlockForChainInLatestFullyExecutedBundle > 0) {
        const depositsToCache = Object.fromEntries(
          Object.keys(this.depositsWithBlockNumbers).map((destinationChainId) => {
            return [
              destinationChainId,
              this.depositsWithBlockNumbers[Number(destinationChainId)]
                .filter((e) => e.originBlockNumber <= endBlockForChainInLatestFullyExecutedBundle)
                .map((deposit) => {
                  return {
                    ...deposit,
                    amount: deposit.amount.toString(),
                    relayerFeePct: deposit.relayerFeePct.toString(),
                    realizedLpFeePct: deposit.realizedLpFeePct.toString(),
                  } as DepositWithBlockInCache
              }),
            ];
          })
        );
        console.log(
          `Updated cached deposits for chain ${this.chainId}, endBlockForChainInLatestFullyExecutedBundle=${endBlockForChainInLatestFullyExecutedBundle}`,
          Object.keys(depositsToCache).map((destChain) => {
            return {
              destChain,
              depositsToCacheCount: depositsToCache[destChain].length,
              depositsToCacheFirst: depositsToCache[destChain][0],
              depositsToCacheLast: depositsToCache[destChain][depositsToCache[destChain].length - 1]
            }
          })
        );
        // Save new deposit cache for chain.
        await this.setDepositDataInCache({
          latestBlock: endBlockForChainInLatestFullyExecutedBundle,
          deposits: depositsToCache,
        })
      }
    }

    if (eventsToQuery.includes("RequestedSpeedUpDeposit")) {
      const speedUpEvents = queryResults[eventsToQuery.indexOf("RequestedSpeedUpDeposit")];

      for (const event of speedUpEvents) {
        const speedUp: SpeedUp = { ...spreadEvent(event), originChainId: this.chainId };
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

      for (const event of fillEvents) {
        this.fills.push(spreadEvent(event));
        this.fillsWithBlockNumbers.push(spreadEventWithBlockNumber(event) as FillWithBlock);
        const newFill = spreadEvent(event);
        assign(this.depositHashesToFills, [this.getDepositHash(newFill)], [newFill]);
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
    this.log("debug", `SpokePool client for chain ${this.chainId} updated!`, searchConfig);
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

  private async getDepositDataFromCache(): Promise<CachedDepositData> {
    if (!this.configStoreClient.redisClient) return {};
    const key = `deposit_data_${this.chainId}`;
    const result = JSON.parse(await this.configStoreClient.redisClient.get(key));
    if (result === null) return {};
    else return result;
  }

  private async setDepositDataInCache(newData: CachedDepositData) {
    if (!this.configStoreClient.redisClient) return;
    const key = `deposit_data_${this.chainId}`;
    await this.configStoreClient.redisClient.set(key, JSON.stringify(newData));
  }

  // Neccessary to use this function because RedisDB can only store strings so we need to stringify the BN objects
  // before storing them in the cache, and do the opposite to retrieve the data type that we expect when fetching
  // from the cache.
  private convertDepositInCache(deposit: DepositWithBlockInCache): DepositWithBlock {
    return {
      ...deposit,
      amount: toBN(deposit.amount),
      relayerFeePct: toBN(deposit.relayerFeePct),
      realizedLpFeePct: toBN(deposit.realizedLpFeePct),
    }
  }

  private async computeRealizedLpFeePct(depositEvent: Event) {
    if (!this.configStoreClient) return { realizedLpFeePct: toBN(0), quoteBlock: 0 }; // If there is no rate model client return 0.
    const deposit = {
      amount: depositEvent.args.amount,
      originChainId: Number(depositEvent.args.originChainId),
      originToken: depositEvent.args.originToken,
      quoteTimestamp: depositEvent.args.quoteTimestamp,
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
