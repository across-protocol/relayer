import { assign, Contract, winston, BigNumber, EventSearchConfig, MakeOptional, BigNumberish } from "../utils";
import {
  fetchTokenInfo,
  Event,
  EventFilter,
  sortEventsDescending,
  spreadEvent,
  spreadEventWithBlockNumber,
  paginatedEventQuery,
  toBN,
} from "../utils";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";
import { Deposit, L1Token, CancelledRootBundle, DisputedRootBundle, LpToken } from "../interfaces";
import { ExecutedRootBundle, PendingRootBundle, ProposedRootBundle } from "../interfaces";
import { CrossChainContractsSet, DestinationTokenWithBlock, SetPoolRebalanceRoot } from "../interfaces";
import _ from "lodash";

type _HubPoolUpdate = {
  success: true;
  currentTime: number;
  latestBlockNumber: number;
  pendingRootBundleProposal: PendingRootBundle;
  events: Record<string, Event[]>;
  searchEndBlock: number;
};
export type HubPoolUpdate = { success: false } | _HubPoolUpdate;

type HubPoolEvent =
  | "SetPoolRebalanceRoute"
  | "SetPoolRebalanceRoute"
  | "L1TokenEnabledForLiquidityProvision"
  | "ProposeRootBundle"
  | "RootBundleCanceled"
  | "RootBundleDisputed"
  | "RootBundleExecuted"
  | "CrossChainContractsSet";

type L1TokensToDestinationTokens = {
  [l1Token: string]: { [destinationChainId: number]: string };
};
export class HubPoolClient {
  // L1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: L1TokensToDestinationTokens = {};
  private l1Tokens: L1Token[] = []; // L1Tokens and their associated info.
  private lpTokens: { [token: string]: LpToken } = {};
  private proposedRootBundles: ProposedRootBundle[] = [];
  private canceledRootBundles: CancelledRootBundle[] = [];
  private disputedRootBundles: DisputedRootBundle[] = [];
  private executedRootBundles: ExecutedRootBundle[] = [];
  private crossChainContracts: { [l2ChainId: number]: CrossChainContractsSet[] } = {};
  private l1TokensToDestinationTokensWithBlock: {
    [l1Token: string]: { [destinationChainId: number]: DestinationTokenWithBlock[] };
  } = {};
  private pendingRootBundle: PendingRootBundle | undefined;

  public isUpdated = false;
  public firstBlockToSearch: number;
  public latestBlockNumber: number | undefined;
  public currentTime: number | undefined;

  constructor(
    readonly logger: winston.Logger,
    readonly hubPool: Contract,
    readonly chainId: number = 1,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
  }

  protected hubPoolEventFilters(): Record<HubPoolEvent, EventFilter> {
    return {
      SetPoolRebalanceRoute: this.hubPool.filters.SetPoolRebalanceRoute(),
      L1TokenEnabledForLiquidityProvision: this.hubPool.filters.L1TokenEnabledForLiquidityProvision(),
      ProposeRootBundle: this.hubPool.filters.ProposeRootBundle(),
      RootBundleCanceled: this.hubPool.filters.RootBundleCanceled(),
      RootBundleDisputed: this.hubPool.filters.RootBundleDisputed(),
      RootBundleExecuted: this.hubPool.filters.RootBundleExecuted(),
      CrossChainContractsSet: this.hubPool.filters.CrossChainContractsSet(),
    };
  }

  hasPendingProposal(): boolean {
    return this.pendingRootBundle !== undefined;
  }

  getPendingRootBundle(): PendingRootBundle | undefined {
    return this.pendingRootBundle;
  }

  getProposedRootBundles(): ProposedRootBundle[] {
    return this.proposedRootBundles;
  }

  getCancelledRootBundles(): CancelledRootBundle[] {
    return this.canceledRootBundles;
  }

  getDisputedRootBundles(): DisputedRootBundle[] {
    return this.disputedRootBundles;
  }

  getSpokePoolForBlock(chain: number, block: number = Number.MAX_SAFE_INTEGER): string {
    if (!this.crossChainContracts[chain]) {
      throw new Error(`No cross chain contracts set for ${chain}`);
    }
    const mostRecentSpokePoolUpdateBeforeBlock = (
      sortEventsDescending(this.crossChainContracts[chain]) as CrossChainContractsSet[]
    ).find((crossChainContract) => crossChainContract.blockNumber <= block);
    if (!mostRecentSpokePoolUpdateBeforeBlock) {
      throw new Error(`No cross chain contract found before block ${block} for chain ${chain}`);
    } else {
      return mostRecentSpokePoolUpdateBeforeBlock.spokePool;
    }
  }

  getSpokePoolActivationBlock(chain: number, spokePool: string): number | undefined {
    // Return first time that this spoke pool was registered in the HubPool as a cross chain contract. We can use
    // this block as the oldest block that we should query for SpokePoolClient purposes.
    const mostRecentSpokePoolUpdateBeforeBlock = this.crossChainContracts[chain].find(
      (crossChainContract) => crossChainContract.spokePool === spokePool
    );
    return mostRecentSpokePoolUpdateBeforeBlock?.blockNumber;
  }

  getDestinationTokenForDeposit(deposit: {
    originChainId: number;
    originToken: string;
    destinationChainId: number;
  }): string {
    const l1Token = this.getL1TokenForDeposit(deposit);
    const destinationToken = this.getDestinationTokenForL1Token(l1Token, deposit.destinationChainId);
    if (!destinationToken) {
      this.logger.error({
        at: "HubPoolClient",
        message: "No destination token found",
        deposit,
        notificationPath: "across-error",
      });
    }
    return destinationToken;
  }

  getL1TokensToDestinationTokens(): L1TokensToDestinationTokens {
    return this.l1TokensToDestinationTokens;
  }

  getL1TokenForDeposit(deposit: { originChainId: number; originToken: string }): string {
    const l1Token = Object.keys(this.l1TokensToDestinationTokens).find((_l1Token) => {
      return this.l1TokensToDestinationTokens[_l1Token][deposit.originChainId] === deposit.originToken;
    });
    if (!l1Token) {
      throw new Error(
        `Could not find L1 Token for origin chain ${deposit.originChainId} and origin token ${deposit.originToken}!`
      );
    }
    return l1Token;
  }

  getL1TokenCounterpartAtBlock(l2ChainId: number, l2Token: string, block: number): string {
    const l1Token = Object.keys(this.l1TokensToDestinationTokensWithBlock).find((_l1Token) => {
      // If this token doesn't exist on this L2, return false.
      if (this.l1TokensToDestinationTokensWithBlock[_l1Token][l2ChainId] === undefined) {
        return false;
      }

      // Find the last mapping published before the target block.
      return sortEventsDescending(this.l1TokensToDestinationTokensWithBlock[_l1Token][l2ChainId]).find(
        (mapping: DestinationTokenWithBlock) => mapping.l2Token === l2Token && mapping.blockNumber <= block
      );
    });
    if (!l1Token) {
      throw new Error(
        `Could not find L1 token mapping for chain ${l2ChainId} and L2 token ${l2Token} equal to or earlier than block ${block}!`
      );
    }
    return l1Token;
  }

  getDestinationTokenForL1Token(l1Token: string, destinationChainId: number): string {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId];
  }

  l2TokenEnabledForL1Token(l1Token: string, destinationChainId: number): boolean {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId] != undefined;
  }
  getDestinationTokensToL1TokensForChainId(chainId: number): { [destinationToken: string]: L1Token } {
    return Object.fromEntries(
      this.l1Tokens
        .map((l1Token): [string, L1Token] => [this.getDestinationTokenForL1Token(l1Token.address, chainId), l1Token])
        .filter((entry) => entry[0] !== undefined)
    );
  }

  async getCurrentPoolUtilization(l1Token: string): Promise<BigNumberish> {
    return await this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token);
  }

  async getPostRelayPoolUtilization(
    l1Token: string,
    quoteBlockNumber: number,
    relaySize: BigNumber
  ): Promise<{
    current: BigNumber;
    post: BigNumber;
  }> {
    const overrides = { blockTag: quoteBlockNumber };
    const [current, post] = await Promise.all([
      this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token, overrides),
      this.hubPool.callStatic.liquidityUtilizationPostRelay(l1Token, relaySize, overrides),
    ]);
    return { current, post };
  }

  getL1Tokens(): L1Token[] {
    return this.l1Tokens;
  }

  getTokenInfoForL1Token(l1Token: string): L1Token | undefined {
    return this.l1Tokens.find((token) => token.address === l1Token);
  }

  getLpTokenInfoForL1Token(l1Token: string): LpToken | undefined {
    return this.lpTokens[l1Token];
  }

  getL1TokenInfoForL2Token(l2Token: string, chainId: number): L1Token | undefined {
    const l1TokenCounterpart = this.getL1TokenCounterpartAtBlock(chainId, l2Token, this.latestBlockNumber || 0);
    return this.getTokenInfoForL1Token(l1TokenCounterpart);
  }

  getTokenInfoForDeposit(deposit: Deposit): L1Token | undefined {
    return this.getTokenInfoForL1Token(this.getL1TokenForDeposit(deposit));
  }

  getTokenInfo(chainId: number | string, tokenAddress: string): L1Token | undefined {
    const deposit = { originChainId: parseInt(chainId.toString()), originToken: tokenAddress } as Deposit;
    return this.getTokenInfoForDeposit(deposit);
  }

  // Root bundles are valid if all of their pool rebalance leaves have been executed before the next bundle, or the
  // latest mainnet block to search. Whichever comes first.
  isRootBundleValid(rootBundle: ProposedRootBundle, latestMainnetBlock: number): boolean {
    const nextRootBundle = this.getFollowingRootBundle(rootBundle);
    const executedLeafCount = this.getExecutedLeavesForRootBundle(
      rootBundle,
      nextRootBundle ? Math.min(nextRootBundle.blockNumber, latestMainnetBlock) : latestMainnetBlock
    );
    return executedLeafCount.length === rootBundle.poolRebalanceLeafCount;
  }

  // This should find the ProposeRootBundle event whose bundle block number for `chain` is closest to the `block`
  // without being smaller. It returns the bundle block number for the chain or undefined if not matched.
  getRootBundleEvalBlockNumberContainingBlock(
    latestMainnetBlock: number,
    block: number,
    chain: number,
    chainIdList: number[]
  ): number | undefined {
    let endingBlockNumber: number | undefined;
    // Search proposed root bundles in reverse chronological order.
    for (let i = this.proposedRootBundles.length - 1; i >= 0; i--) {
      const rootBundle = this.proposedRootBundles[i];
      const nextRootBundle = this.getFollowingRootBundle(rootBundle);
      if (!this.isRootBundleValid(rootBundle, nextRootBundle ? nextRootBundle.blockNumber : latestMainnetBlock)) {
        continue;
      }

      // 0 is the default value bundleEvalBlockNumber.
      const bundleEvalBlockNumber = this.getBundleEndBlockForChain(
        rootBundle as ProposedRootBundle,
        chain,
        chainIdList
      );

      // Since we're iterating from newest to oldest, bundleEvalBlockNumber is only decreasing, and if the
      // bundleEvalBlockNumber is smaller than the target block, then we should return the last set `endingBlockNumber`.
      if (bundleEvalBlockNumber <= block) {
        if (bundleEvalBlockNumber === block) {
          endingBlockNumber = bundleEvalBlockNumber;
        }
        break;
      }
      endingBlockNumber = bundleEvalBlockNumber;
    }
    return endingBlockNumber;
  }

  // TODO: This might not be necessary since the cumulative root bundle count doesn't grow fast enough, but consider
  // using _.findLast/_.find instead of resorting the arrays if these functions begin to take a lot time.
  getProposedRootBundlesInBlockRange(startingBlock: number, endingBlock: number): ProposedRootBundle[] {
    return this.proposedRootBundles.filter(
      (bundle: ProposedRootBundle) => bundle.blockNumber >= startingBlock && bundle.blockNumber <= endingBlock
    );
  }

  getCancelledRootBundlesInBlockRange(startingBlock: number, endingBlock: number): CancelledRootBundle[] {
    return sortEventsDescending(this.canceledRootBundles).filter(
      (bundle: CancelledRootBundle) => bundle.blockNumber >= startingBlock && bundle.blockNumber <= endingBlock
    );
  }

  getDisputedRootBundlesInBlockRange(startingBlock: number, endingBlock: number): DisputedRootBundle[] {
    return sortEventsDescending(this.disputedRootBundles).filter(
      (bundle: DisputedRootBundle) => bundle.blockNumber >= startingBlock && bundle.blockNumber <= endingBlock
    );
  }

  getLatestProposedRootBundle(): ProposedRootBundle {
    return this.proposedRootBundles[this.proposedRootBundles.length - 1] as ProposedRootBundle;
  }

  getFollowingRootBundle(currentRootBundle: ProposedRootBundle): ProposedRootBundle {
    const index = _.findLastIndex(
      this.proposedRootBundles,
      (bundle) => bundle.blockNumber === currentRootBundle.blockNumber
    );
    // If index of current root bundle is not found or is the last bundle, return undefined.
    if (index === -1 || index === this.proposedRootBundles.length - 1) {
      return undefined;
    }
    return this.proposedRootBundles[index + 1];
  }

  getExecutedLeavesForRootBundle(
    rootBundle: ProposedRootBundle,
    latestMainnetBlockToSearch: number
  ): ExecutedRootBundle[] {
    return this.executedRootBundles.filter(
      (executedLeaf: ExecutedRootBundle) =>
        executedLeaf.blockNumber <= latestMainnetBlockToSearch &&
        // Note: We can use > instead of >= here because a leaf can never be executed in same block as its root
        // proposal due to bundle liveness enforced by HubPool. This importantly avoids the edge case
        // where the execution all leaves occurs in the same block as the next proposal, leading us to think
        // that the next proposal is fully executed when its not.
        executedLeaf.blockNumber > rootBundle.blockNumber
    ) as ExecutedRootBundle[];
  }

  getValidatedRootBundles(latestMainnetBlock: number = Number.MAX_SAFE_INTEGER): ProposedRootBundle[] {
    return this.proposedRootBundles.filter((rootBundle: ProposedRootBundle) => {
      if (rootBundle.blockNumber > latestMainnetBlock) {
        return false;
      }
      return this.isRootBundleValid(rootBundle, latestMainnetBlock);
    });
  }

  getLatestFullyExecutedRootBundle(latestMainnetBlock: number): ProposedRootBundle | undefined {
    // Search for latest ProposeRootBundleExecuted event followed by all of its RootBundleExecuted event suggesting
    // that all pool rebalance leaves were executed. This ignores any proposed bundles that were partially executed.
    return _.findLast(this.proposedRootBundles, (rootBundle: ProposedRootBundle) => {
      if (rootBundle.blockNumber > latestMainnetBlock) {
        return false;
      }
      return this.isRootBundleValid(rootBundle, latestMainnetBlock);
    });
  }

  getEarliestFullyExecutedRootBundle(latestMainnetBlock: number, startBlock = 0): ProposedRootBundle | undefined {
    return this.proposedRootBundles.find((rootBundle: ProposedRootBundle) => {
      if (rootBundle.blockNumber > latestMainnetBlock) {
        return false;
      }
      if (rootBundle.blockNumber < startBlock) {
        return false;
      }
      return this.isRootBundleValid(rootBundle, latestMainnetBlock);
    });
  }

  // If n is negative, then return the Nth latest executed bundle, otherwise return the Nth earliest
  // executed bundle. Latest means most recent, earliest means oldest. N cannot be 0.
  // `startBlock` can be used to set the starting point from which we look forwards or backwards, depending
  // on whether n is positive or negative.
  getNthFullyExecutedRootBundle(n: number, startBlock?: number): ProposedRootBundle | undefined {
    if (n === 0) {
      throw new Error("n cannot be 0");
    }
    if (!this.latestBlockNumber) {
      throw new Error("HubPoolClient::getNthFullyExecutedRootBundle client not updated");
    }

    let bundleToReturn: ProposedRootBundle | undefined;

    // If n is negative, then return the Nth latest executed bundle, otherwise return the Nth earliest
    // executed bundle.
    if (n < 0) {
      let nextLatestMainnetBlock = startBlock ?? this.latestBlockNumber;
      for (let i = 0; i < Math.abs(n); i++) {
        bundleToReturn = this.getLatestFullyExecutedRootBundle(nextLatestMainnetBlock);
        const bundleBlockNumber = bundleToReturn ? bundleToReturn.blockNumber : 0;

        // Subtract 1 so that next `getLatestFullyExecutedRootBundle` call filters out the root bundle we just found
        // because its block number is > nextLatestMainnetBlock.
        nextLatestMainnetBlock = Math.max(0, bundleBlockNumber - 1);
      }
    } else {
      let nextStartBlock = startBlock ?? 0;
      for (let i = 0; i < n; i++) {
        bundleToReturn = this.getEarliestFullyExecutedRootBundle(this.latestBlockNumber, nextStartBlock);
        const bundleBlockNumber = bundleToReturn ? bundleToReturn.blockNumber : 0;

        // Add 1 so that next `getEarliestFullyExecutedRootBundle` call filters out the root bundle we just found
        // because its block number is < nextStartBlock.
        nextStartBlock = Math.min(bundleBlockNumber + 1, this.latestBlockNumber);
      }
    }

    return bundleToReturn;
  }

  getLatestBundleEndBlockForChain(chainIdList: number[], latestMainnetBlock: number, chainId: number): number {
    const latestFullyExecutedPoolRebalanceRoot = this.getLatestFullyExecutedRootBundle(latestMainnetBlock);

    // If no event, then we can return a conservative default starting block like 0,
    // or we could throw an Error.
    if (!latestFullyExecutedPoolRebalanceRoot) {
      return 0;
    }

    // Once this proposal event is found, determine its mapping of indices to chainId in its
    // bundleEvaluationBlockNumbers array using CHAIN_ID_LIST. For each chainId, their starting block number is that
    // chain's bundleEvaluationBlockNumber + 1 in this past proposal event.
    return this.getBundleEndBlockForChain(latestFullyExecutedPoolRebalanceRoot, chainId, chainIdList);
  }

  getNextBundleStartBlockNumber(chainIdList: number[], latestMainnetBlock: number, chainId: number): number {
    const endBlock = this.getLatestBundleEndBlockForChain(chainIdList, latestMainnetBlock, chainId);

    // This assumes that chain ID's are only added to the chain ID list over time, and that chains are never
    // deleted.
    return endBlock > 0 ? endBlock + 1 : 0;
  }

  getRunningBalanceBeforeBlockForChain(block: number, chain: number, l1Token: string): BigNumber {
    // Search through ExecutedRootBundle events in descending block order so we find the most recent event not greater
    // than the target block.
    const mostRecentExecutedRootBundleEvent = sortEventsDescending(this.executedRootBundles).find(
      (executedLeaf: ExecutedRootBundle) => {
        return (
          executedLeaf.blockNumber <= block &&
          executedLeaf.chainId === chain &&
          executedLeaf.l1Tokens.map((l1Token) => l1Token.toLowerCase()).includes(l1Token.toLowerCase())
        );
      }
    ) as ExecutedRootBundle;
    if (mostRecentExecutedRootBundleEvent) {
      // Arguably we don't need to even check these array lengths since we should assume that any proposed root bundle
      // meets this condition.
      if (
        mostRecentExecutedRootBundleEvent.l1Tokens.length !== mostRecentExecutedRootBundleEvent.runningBalances.length
      ) {
        throw new Error("runningBalances and L1 token of ExecutedRootBundle event are not same length");
      }
      const indexOfL1Token = mostRecentExecutedRootBundleEvent.l1Tokens
        .map((l1Token) => l1Token.toLowerCase())
        .indexOf(l1Token.toLowerCase());
      return mostRecentExecutedRootBundleEvent.runningBalances[indexOfL1Token];
    } else {
      return toBN(0);
    }
  }

  async _update(eventNames: HubPoolEvent[]): Promise<HubPoolUpdate> {
    const latestBlockNumber = await this.hubPool.provider.getBlockNumber();
    const hubPoolEvents = this.hubPoolEventFilters();

    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    if (searchConfig.fromBlock > searchConfig.toBlock) {
      this.logger.warn({ at: "HubPoolClient#_update", message: "Invalid update() searchConfig.", searchConfig });
      return { success: false };
    }

    this.logger.debug({
      at: "HubPoolClient",
      message: "Updating HubPool client",
      searchConfig,
      eventNames,
    });
    const timerStart = Date.now();
    const [currentTime, pendingRootBundleProposal, ...events] = await Promise.all([
      this.hubPool.getCurrentTime(),
      this.hubPool.rootBundleProposal(),
      ...eventNames.map((eventName) => paginatedEventQuery(this.hubPool, hubPoolEvents[eventName], searchConfig)),
    ]);
    this.logger.debug({
      at: "HubPoolClient#_update",
      message: `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`,
    });

    const _events = Object.fromEntries(eventNames.map((eventName, idx) => [eventName, events[idx]]));

    return {
      success: true,
      currentTime,
      latestBlockNumber,
      pendingRootBundleProposal,
      searchEndBlock: searchConfig.toBlock,
      events: _events,
    };
  }

  async update(eventsToQuery?: HubPoolEvent[]): Promise<void> {
    eventsToQuery ??= Object.keys(this.hubPoolEventFilters()) as HubPoolEvent[]; // Query all events by default.

    const update = await this._update(eventsToQuery);
    if (!update.success) {
      // This failure only occurs if the RPC searchConfig is miscomputed, and has only been seen in the hardhat test
      // environment. Normal failures will throw instead. This is therefore an unfortunate workaround until we can
      // understand why we see this in test. @todo: Resolve.
      return;
    }
    const { events, currentTime, latestBlockNumber, pendingRootBundleProposal } = update;

    for (const event of events["CrossChainContractsSet"]) {
      const args = spreadEventWithBlockNumber(event) as CrossChainContractsSet;
      assign(
        this.crossChainContracts,
        [args.l2ChainId],
        [
          {
            spokePool: args.spokePool,
            blockNumber: args.blockNumber,
            transactionIndex: args.transactionIndex,
            logIndex: args.logIndex,
          },
        ]
      );
    }

    for (const event of events["SetPoolRebalanceRoute"]) {
      const args = spreadEventWithBlockNumber(event) as SetPoolRebalanceRoot;
      assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], args.destinationToken);
      assign(
        this.l1TokensToDestinationTokensWithBlock,
        [args.l1Token, args.destinationChainId],
        [
          {
            l2Token: args.destinationToken,
            blockNumber: args.blockNumber,
            transactionIndex: args.transactionIndex,
            logIndex: args.logIndex,
          },
        ]
      );
    }

    // For each enabled Lp token fetch the token symbol and decimals from the token contract. Note this logic will
    // only run iff a new token has been enabled. Will only append iff the info is not there already.
    // Filter out any duplicate addresses. This might happen due to enabling, disabling and re-enabling a token.
    const uniqueL1Tokens = [
      ...new Set(events["L1TokenEnabledForLiquidityProvision"].map((event) => spreadEvent(event.args).l1Token)),
    ];
    const [tokenInfo, lpTokenInfo] = await Promise.all([
      Promise.all(uniqueL1Tokens.map((l1Token: string) => fetchTokenInfo(l1Token, this.hubPool.signer))),
      Promise.all(uniqueL1Tokens.map(async (l1Token: string) => await this.hubPool.pooledTokens(l1Token))),
    ]);
    for (const info of tokenInfo) {
      if (!this.l1Tokens.find((token) => token.symbol === info.symbol)) {
        if (info.decimals > 0 && info.decimals <= 18) {
          this.l1Tokens.push(info);
        } else {
          throw new Error(`Unsupported HubPool token: ${JSON.stringify(info)}`);
        }
      }
    }

    uniqueL1Tokens.forEach((token: string, i) => {
      this.lpTokens[token] = { lastLpFeeUpdate: lpTokenInfo[i].lastLpFeeUpdate };
    });

    this.proposedRootBundles.push(
      ...events["ProposeRootBundle"]
        .filter((event) => !IGNORED_HUB_PROPOSED_BUNDLES.includes(event.blockNumber))
        .map((event) => {
          return { ...spreadEventWithBlockNumber(event), transactionHash: event.transactionHash } as ProposedRootBundle;
        })
    );
    this.canceledRootBundles.push(
      ...events["RootBundleCanceled"].map((event) => spreadEventWithBlockNumber(event) as CancelledRootBundle)
    );
    this.disputedRootBundles.push(
      ...events["RootBundleDisputed"].map((event) => spreadEventWithBlockNumber(event) as DisputedRootBundle)
    );
    this.executedRootBundles.push(
      ...events["RootBundleExecuted"]
        .filter((event) => !IGNORED_HUB_EXECUTED_BUNDLES.includes(event.blockNumber))
        .map((event) => spreadEventWithBlockNumber(event) as ExecutedRootBundle)
    );

    // If the contract's current rootBundleProposal() value has an unclaimedPoolRebalanceLeafCount > 0, then
    // it means that either the root bundle proposal is in the challenge period and can be disputed, or it has
    // passed the challenge period and pool rebalance leaves can be executed. Once all leaves are executed, the
    // unclaimed count will drop to 0 and at that point there is nothing more that we can do with this root bundle
    // besides proposing another one.
    if (pendingRootBundleProposal.unclaimedPoolRebalanceLeafCount > 0) {
      const mostRecentProposedRootBundle = this.proposedRootBundles[this.proposedRootBundles.length - 1];
      this.pendingRootBundle = {
        poolRebalanceRoot: pendingRootBundleProposal.poolRebalanceRoot,
        relayerRefundRoot: pendingRootBundleProposal.relayerRefundRoot,
        slowRelayRoot: pendingRootBundleProposal.slowRelayRoot,
        proposer: pendingRootBundleProposal.proposer,
        unclaimedPoolRebalanceLeafCount: pendingRootBundleProposal.unclaimedPoolRebalanceLeafCount,
        challengePeriodEndTimestamp: pendingRootBundleProposal.challengePeriodEndTimestamp,
        bundleEvaluationBlockNumbers: mostRecentProposedRootBundle.bundleEvaluationBlockNumbers.map(
          (block: BigNumber) => {
            // Ideally, the HubPool.sol contract should limit the size of the elements within the
            // bundleEvaluationBlockNumbers array. But because it doesn't, we wrap the cast of BN --> Number
            // in a try/catch statement and return some value that would always be disputable.
            // This catches the denial of service attack vector where a malicious proposer proposes with bundle block
            // evaluation block numbers larger than what BigNumber::toNumber() can handle.
            try {
              return block.toNumber();
            } catch {
              return 0;
            }
          }
        ),
        proposalBlockNumber: mostRecentProposedRootBundle.blockNumber,
      };
    } else {
      this.pendingRootBundle = undefined;
    }

    this.currentTime = currentTime;
    this.latestBlockNumber = latestBlockNumber;
    this.firstBlockToSearch = update.searchEndBlock + 1; // Next iteration should start off from where this one ended.

    this.isUpdated = true;
    this.logger.debug({ at: "HubPoolClient", message: "HubPool client updated!" });
  }

  // Returns end block for `chainId` in ProposedRootBundle.bundleBlockEvalNumbers. Looks up chainId
  // in chainId list, gets the index where its located, and returns the value of the index in
  // bundleBlockEvalNumbers. Returns 0 if `chainId` can't be found in `chainIdList` and if index doesn't
  // exist in bundleBlockEvalNumbers.
  private getBundleEndBlockForChain(
    proposeRootBundleEvent: ProposedRootBundle,
    chainId: number,
    chainIdList: number[]
  ): number {
    const bundleEvaluationBlockNumbers: BigNumber[] = proposeRootBundleEvent.bundleEvaluationBlockNumbers;
    const chainIdIndex = chainIdList.indexOf(chainId);
    if (chainIdIndex === -1) {
      return 0;
    }
    // Sometimes, the root bundle event's chain ID list will update from bundle to bundle, so we need to check that
    // the bundle evaluation block number list is long enough to contain this index. We assume that chain ID's
    // are only added to the bundle block list, never deleted.
    if (chainIdIndex >= bundleEvaluationBlockNumbers.length) {
      return 0;
    }
    return bundleEvaluationBlockNumbers[chainIdIndex].toNumber();
  }
}
