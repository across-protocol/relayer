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
  getContract,
  ethers,
  Block,
  getCurrentTime,
  sortEventsAscending,
  sortEventsDescending,
} from "../utils";
import { toBN, winston, paginatedEventQuery, spreadEventWithBlockNumber } from "../utils";

import { AcrossConfigStoreClient } from "./ConfigStoreClient";
import {
  Deposit,
  DepositWithBlock,
  Fill,
  SpeedUp,
  FillWithBlock,
  TokensBridged,
  FundsDepositedEvent,
  ActiveSpokePool,
  ActiveCrossChainContract,
} from "../interfaces/SpokePool";
import { RootBundleRelayWithBlock, RelayerRefundExecutionWithBlock } from "../interfaces/SpokePool";
import { BlockFinder } from "@uma/sdk";
import { createClient } from "redis4";
import { HubPoolClient } from "./HubPoolClient";

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

type RedisClient = ReturnType<typeof createClient>;

export class SpokePoolClient {
  private depositHashes: { [depositHash: string]: DepositWithBlock } = {};
  private depositHashesToFills: { [depositHash: string]: FillWithBlock[] } = {};
  private speedUps: { [depositorAddress: string]: { [depositId: number]: SpeedUp[] } } = {};
  private depositRoutes: { [originToken: string]: { [DestinationChainId: number]: boolean } } = {};
  private tokensBridged: TokensBridged[] = [];
  private rootBundleRelays: RootBundleRelayWithBlock[] = [];
  private relayerRefundExecutions: RelayerRefundExecutionWithBlock[] = [];
  private l2BlockFinders: { [chainId: number]: BlockFinder<Block> } = {};
  private redisClient?: RedisClient;
  public activeSpokePools: ActiveSpokePool[] = [];
  public earliestDepositId: number = Number.MAX_SAFE_INTEGER;
  public isUpdated = false;
  public firstBlockToSearch: number;
  public latestBlockNumber: number | undefined;
  public deposits: { [DestinationChainId: number]: DepositWithBlock[] } = {};
  public fills: { [OriginChainId: number]: FillWithBlock[] } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    readonly hubPoolClient: HubPoolClient,
    // ConfigStoreClient can be excluded. This disables some deposit validation.
    readonly configStoreClient: AcrossConfigStoreClient | null,
    readonly chainId: number,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    readonly spokePoolDeploymentBlock: number = 0
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.redisClient = configStoreClient?.redisClient;
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
  validateFillForDeposit(fill: Fill, deposit: Deposit) {
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

  getProvider(): ethers.providers.Provider {
    return this.spokePool.provider;
  }

  async update(eventsToQuery?: string[]) {
    if (this.configStoreClient !== null && !this.configStoreClient.isUpdated) throw new Error("RateModel not updated");
    const { NODE_MAX_CONCURRENCY } = process.env;
    // Default to a max concurrency of 1000 requests per node.
    const nodeMaxConcurrency = Number(
      process.env[`NODE_MAX_CONCURRENCY_${this.chainId}`] || NODE_MAX_CONCURRENCY || "1000"
    );

    // Require that all Deposits meet the minimum specified number of confirmations.
    this.latestBlockNumber = await this.getProvider().getBlockNumber();
    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || this.latestBlockNumber,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    if (searchConfig.fromBlock > searchConfig.toBlock) return; // If the starting block is greater than the ending block return.

    // By default, an event's query range can be overridden (usually shortened) by the `eventSearchConfig`
    // passed in to the Config object. However, certain types of have special rules that could change their
    // search ranges. For example, the following event names should only be queried from the deployment block
    // of the CURRENT spoke pool.
    const eventsToQueryFromSpokePoolDeploymentBlock = ["EnabledDepositRoute"];
    const deploymentBlockSearchConfig = { ...searchConfig }; // shallow copy.
    if (!this.isUpdated) deploymentBlockSearchConfig.fromBlock = this.spokePoolDeploymentBlock;
    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      searchConfig,
      deploymentBlockSearchConfig,
      spokePool: this.spokePool.address,
    });

    // If caller specifies which events to query, then only query those. This can be used by bots to limit web3
    // requests. Otherwise, default to looking up all events.
    if (eventsToQuery === undefined) eventsToQuery = Object.keys(this._queryableEventNames());
    const eventSearchConfigs = eventsToQuery.map((eventName) => {
      if (!Object.keys(this._queryableEventNames()).includes(eventName))
        throw new Error("Unknown event to query in SpokePoolClient");
      const searchConfigToUse = eventsToQueryFromSpokePoolDeploymentBlock.includes(eventName)
        ? deploymentBlockSearchConfig
        : searchConfig;
      return {
        eventName,
        filter: this._queryableEventNames()[eventName],
        searchConfig: searchConfigToUse,
      };
    });

    // If there are CrossChainContract events, then assert the class's spoke pool is equal to the latest one, otherwise
    // risk sending transactions to the wrong spoke pool.
    const allSpokePools = await this.getSpokePools();
    if (allSpokePools.length > 0) {
      if (allSpokePools[allSpokePools.length - 1].spokePool !== this.spokePool.address)
        throw new Error("SpokePoolClient's spoke pool is not latest");
    }
    this.log("debug", "Spoke pools to query for events", {
      relayEvents: Object.keys(this._queryableEventNames()).filter(
        (eventName) => !eventsToQueryFromSpokePoolDeploymentBlock.includes(eventName)
      ),
      relayEventSearchConfig: searchConfig,
      relayEventsSpokePools: Object.entries(this.getActiveSpokePoolsForBlocks(allSpokePools, searchConfig)).map(
        ([, crossChainContract]) => {
          return {
            spokePool: crossChainContract.contract.address,
            transactionHash: crossChainContract.transactionHash,
            activeBlocks: crossChainContract.activeBlocks,
          };
        }
      ),
      otherEvents: eventsToQueryFromSpokePoolDeploymentBlock,
      otherEventSearchConfig: deploymentBlockSearchConfig,
      otherEventsSpokePools: Object.entries(
        this.getActiveSpokePoolsForBlocks(allSpokePools, deploymentBlockSearchConfig)
      ).map(([, crossChainContract]) => {
        return {
          spokePool: crossChainContract.contract.address,
          transactionHash: crossChainContract.transactionHash,
          activeBlocks: crossChainContract.activeBlocks,
        };
      }),
    });
    // For all events not included in `eventsToQueryFromSpokePoolDeploymentBlock`, we may need to query the events
    // from multiple spoke pools.
    const timerStart = Date.now();
    const queryResults = await Promise.all(
      eventSearchConfigs.map(async (config) => {
        // If event is supposed to be searched on current spoke pool beginning at its deployment block, there is no
        // need to send multiply event searches across different spoke pools.
        if (eventsToQueryFromSpokePoolDeploymentBlock.includes(config.eventName))
          return paginatedEventQuery(this.spokePool, config.filter, config.searchConfig);

        const activeSpokePools: ActiveSpokePool[] = this.getActiveSpokePoolsForBlocks(
          allSpokePools,
          config.searchConfig
        );
        return (
          await Promise.all(
            activeSpokePools.map((spokePool) => {
              // If the spoke pool was deactivated before the beginning of the query range then we have no reason to query
              // it for any events. This allows for an unlikely edge case that a spoke pool event appears in the same
              // block that the spoke pool is downgraded but at a later transactionIndex/logIndex. This is why it is
              // important for the HubPool admin to first pause events on the spoke pool before downgrading it.
              if (spokePool.activeBlocks.toBlock < config.searchConfig.fromBlock) return undefined;
              else {
                const queryToUseForSpokePool = {
                  fromBlock: Math.max(config.searchConfig.fromBlock, spokePool.activeBlocks.fromBlock),
                  toBlock: spokePool.activeBlocks.toBlock,
                  maxBlockLookBack: config.searchConfig.maxBlockLookBack,
                };
                return paginatedEventQuery(spokePool.contract, config.filter, queryToUseForSpokePool);
              }
            })
          )
        )
          .flat()
          .filter((x) => x !== undefined);
      })
    );
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
        const processedEvent: Omit<Deposit, "destinationToken" | "realizedLpFeePct"> = spreadEvent(event);

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

        if (deposit.depositId < this.earliestDepositId) this.earliestDepositId = deposit.depositId;
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

  private async computeRealizedLpFeePct(depositEvent: FundsDepositedEvent) {
    if (!this.configStoreClient) return { realizedLpFeePct: toBN(0), quoteBlock: 0 }; // If there is no rate model client return 0.
    const deposit = {
      amount: depositEvent.args.amount,
      originChainId: Number(depositEvent.args.originChainId),
      originToken: depositEvent.args.originToken,
      quoteTimestamp: depositEvent.args.quoteTimestamp,
    };

    return this.configStoreClient.computeRealizedLpFeePct(deposit, this.hubPoolClient.getL1TokenForDeposit(deposit));
  }

  private getDestinationTokenForDeposit(deposit: {
    originChainId: number;
    originToken: string;
    destinationChainId: number;
  }): string {
    return this.hubPoolClient.getDestinationTokenForDeposit(deposit);
  }

  private async getL2EquivalentBlockNumber(l1Block: number) {
    // If this function is called many times in one run, then its result should be cached.
    const l1Provider = this.hubPoolClient.getProvider();
    const timestamp = (await l1Provider.getBlock(l1Block)).timestamp;
    if (!this.l2BlockFinders[this.chainId]) {
      const l2Provider = this.getProvider();
      this.l2BlockFinders[this.chainId] = new BlockFinder(l2Provider.getBlock.bind(l2Provider));
    }
    if (!this.redisClient) {
      return (await this.l2BlockFinders[this.chainId].getBlockForTimestamp(timestamp)).number;
    }
    const key = `l2_${this.chainId}_block_number_${timestamp}`;
    const result = await this.redisClient.get(key);
    if (result === null) {
      const blockNumber = (await this.l2BlockFinders[this.chainId].getBlockForTimestamp(timestamp)).number;
      if (this.shouldCache(timestamp)) await this.redisClient.set(key, blockNumber.toString());
      return blockNumber;
    } else {
      return parseInt(result);
    }
  }

  public async getSpokePools(): Promise<ActiveCrossChainContract[]> {
    const crossChainContracts = this.hubPoolClient.getSpokePools(this.chainId);
    const activatedFromBlocks = await Promise.all(
      crossChainContracts.map((event) => this.getL2EquivalentBlockNumber(event.blockNumber))
    );
    // Set active toBlocks to fromBlock of next event. This assumes that `crossChainContracts`
    // are sorted in ascending chronological order.
    const activatedToBlocks = activatedFromBlocks.map((_block, index) => {
      if (index === activatedFromBlocks.length - 1) return this.latestBlockNumber;
      return activatedFromBlocks[index + 1] - 1;
    });

    return crossChainContracts.map((event, i) => {
      return {
        ...event,
        activeBlocks: { fromBlock: activatedFromBlocks[i], toBlock: activatedToBlocks[i] },
      };
    });
  }

  public getActiveSpokePoolsForBlocks(
    allSpokePools: ActiveCrossChainContract[],
    searchConfig: Omit<EventSearchConfig, "maxBlockLookBack">
  ): ActiveSpokePool[] {
    // If there has never been an activated spoke pools, then default to the default spoke pool. This is only useful
    // in tests and before the first spoke pool is activated.
    if (allSpokePools.length === 0)
      return [
        {
          activeBlocks: searchConfig,
          contract: this.spokePool,
        },
      ];

    // console.log(
    //   "All Historical Activated Contracts:",
    //   JSON.stringify(
    //     allSpokePools.map((spokePool) => {
    //       return {
    //         chainId: this.chainId,
    //         blockNumber: spokePool.blockNumber,
    //         spokePool: spokePool.spokePool,
    //         activeBlocks: spokePool.activeBlocks,
    //         transactionHash: spokePool.transactionHash,
    //       };
    //     }),
    //     null,
    //     2
    //   )
    // );

    // Return all CrossChainContractsSet events after the most recent CrossChainContractsSet before the fromBlock
    // until we get one that happened after the toBlock.
    const activeSpokePools = sortEventsAscending(allSpokePools)
      .filter((spokePool) => {
        return (
          spokePool.activeBlocks.toBlock >= searchConfig.fromBlock &&
          spokePool.activeBlocks.fromBlock <= searchConfig.toBlock
        );
      })
      // If consecutive spoke pool upgrades are for the same contract address, then squash them together.
      .reduce((activeSpokePools: ActiveCrossChainContract[], activeSpokePoolCurr: ActiveCrossChainContract, i) => {
        if (i === 0) return [activeSpokePoolCurr];
        if (activeSpokePoolCurr.spokePool === activeSpokePools[activeSpokePools.length - 1].spokePool) {
          activeSpokePools[activeSpokePools.length - 1].activeBlocks.toBlock = activeSpokePoolCurr.activeBlocks.toBlock;
          activeSpokePools[activeSpokePools.length - 1].transactionHash = activeSpokePoolCurr.transactionHash;
        } else activeSpokePools.push(activeSpokePoolCurr);
        return activeSpokePools;
      }, [])
      .map((spokePool) => {
        return {
          activeBlocks: spokePool.activeBlocks,
          transactionHash: spokePool.transactionHash,
          contract: getContract(spokePool.spokePool, "SpokePool", this.chainId, this.getProvider()),
        };
      });
    return activeSpokePools;
  }

  private log(level: DefaultLogLevels, message: string, data?: any) {
    this.logger[level]({ at: "SpokePoolClient", chainId: this.chainId, message, ...data });
  }

  // Avoid caching calls that are recent enough to be affected by things like reorgs.
  private shouldCache(eventTimestamp: number) {
    // Current time must be >= 5 minutes past the event timestamp for it to be stable enough to cache.
    return getCurrentTime() - eventTimestamp >= 300;
  }
}
