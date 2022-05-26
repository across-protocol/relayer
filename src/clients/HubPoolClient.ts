import { assign, Contract, winston, BigNumber, ERC20, sortEventsAscending, EventSearchConfig } from "../utils";
import { sortEventsDescending, spreadEvent, spreadEventWithBlockNumber, paginatedEventQuery, toBN } from "../utils";
import { EMPTY_MERKLE_ROOT } from "../utils";
import { Deposit, L1Token, ProposedRootBundle, ExecutedRootBundle, RootBundle } from "../interfaces";
import { CrossChainContractsSet, DestinationTokenWithBlock, SetPoolRebalanceRoot } from "../interfaces";

export class HubPoolClient {
  // L1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: { [l1Token: string]: { [destinationChainId: number]: string } } = {};
  private l1Tokens: L1Token[] = []; // L1Tokens and their associated info.
  private proposedRootBundles: ProposedRootBundle[] = [];
  private executedRootBundles: ExecutedRootBundle[] = [];
  private crossChainContracts: { [l2ChainId: number]: CrossChainContractsSet[] } = {};
  private l1TokensToDestinationTokensWithBlock: {
    [l1Token: string]: { [destinationChainId: number]: DestinationTokenWithBlock[] };
  } = {};
  private pendingRootBundle: RootBundle;

  public isUpdated: boolean = false;
  public firstBlockToSearch: number;
  public latestBlockNumber: number;
  public currentTime: number;

  constructor(
    readonly logger: winston.Logger,
    readonly hubPool: Contract,
    readonly eventSearchConfig: EventSearchConfig = { fromBlock: 0, toBlock: null, maxBlockLookBack: 0 }
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
  }

  getPendingRootBundleProposal() {
    return this.pendingRootBundle;
  }

  hasPendingProposal() {
    return this.pendingRootBundle !== undefined && this.pendingRootBundle.unclaimedPoolRebalanceLeafCount > 0;
  }

  getPendingRootBundleIfAvailable() {
    const hasPendingProposal = this.hasPendingProposal();
    const pendingRootBundle = hasPendingProposal ? this.getPendingRootBundleProposal() : undefined;
    return {
      hasPendingProposal,
      pendingRootBundle,
    };
  }

  getProposedRootBundles() {
    return this.proposedRootBundles;
  }

  getSpokePoolForBlock(block: number, chain: number): string {
    if (!this.crossChainContracts[chain]) throw new Error(`No cross chain contracts set for ${chain}`);
    const mostRecentSpokePoolUpdatebeforeBlock = (
      sortEventsDescending(this.crossChainContracts[chain]) as CrossChainContractsSet[]
    ).find((crossChainContract) => crossChainContract.blockNumber <= block);
    if (!mostRecentSpokePoolUpdatebeforeBlock)
      throw new Error(`No cross chain contract found before block ${block} for chain ${chain}`);
    else return mostRecentSpokePoolUpdatebeforeBlock.spokePool;
  }

  getDestinationTokenForDeposit(deposit: Deposit) {
    const l1Token = this.getL1TokenForDeposit(deposit);
    const destinationToken = this.getDestinationTokenForL1Token(l1Token, deposit.destinationChainId);
    if (!destinationToken)
      this.logger.error({
        at: "HubPoolClient",
        message: "No destination token found",
        deposit,
        notificationPath: "across-error",
      });
    return destinationToken;
  }

  getL1TokensToDestinationTokens() {
    return this.l1TokensToDestinationTokens;
  }

  getL1TokenForDeposit(deposit: Deposit) {
    let l1Token = null;
    Object.keys(this.l1TokensToDestinationTokens).forEach((_l1Token) => {
      if (this.l1TokensToDestinationTokens[_l1Token][deposit.originChainId.toString()] === deposit.originToken)
        l1Token = _l1Token;
    });
    if (l1Token === null)
      throw new Error(
        `Could not find L1 Token for origin chain ${deposit.originChainId} and origin token ${deposit.originToken}!`
      );
    return l1Token;
  }

  getL1TokenCounterpartAtBlock(l2ChainId: string, l2Token: string, block: number) {
    const l1Token = Object.keys(this.l1TokensToDestinationTokensWithBlock).find((_l1Token) => {
      // Find the last mapping published before the target block.
      return sortEventsDescending(this.l1TokensToDestinationTokensWithBlock[_l1Token][l2ChainId]).find(
        (mapping: DestinationTokenWithBlock) => mapping.l2Token === l2Token && mapping.blockNumber <= block
      );
    });
    if (!l1Token)
      throw new Error(
        `Could not find L1 token mapping for chain ${l2ChainId} and L2 token ${l2Token} equal to or earlier than block ${block}!`
      );
    return l1Token;
  }

  getDestinationTokenForL1Token(l1Token: string, destinationChainId: number) {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId];
  }

  async getCurrentPoolUtilization(l1Token: string) {
    return await this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token);
  }

  async getPostRelayPoolUtilization(l1Token: string, quoteBlockNumber: number, relaySize: BigNumber) {
    const overrides = { blockTag: quoteBlockNumber };
    const [current, post] = await Promise.all([
      this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token, overrides),
      this.hubPool.callStatic.liquidityUtilizationPostRelay(l1Token, relaySize, overrides),
    ]);
    return { current, post };
  }

  getL1Tokens() {
    return this.l1Tokens;
  }

  getTokenInfoForL1Token(l1Token: string): L1Token {
    return this.l1Tokens.find((token) => token.address === l1Token);
  }

  getTokenInfoForDeposit(deposit: Deposit): L1Token {
    return this.getTokenInfoForL1Token(this.getL1TokenForDeposit(deposit));
  }

  getTokenInfo(chainId: number | string, tokenAddress: string): L1Token {
    const deposit = { originChainId: parseInt(chainId.toString()), originToken: tokenAddress } as Deposit;
    return this.getTokenInfoForDeposit(deposit);
  }

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
    let endingBlockNumber: number;
    for (const rootBundle of sortEventsAscending(this.proposedRootBundles)) {
      if (!this.isRootBundleValid(rootBundle, latestMainnetBlock)) continue;

      const bundleEvalBlockNumber = this.getBundleEndBlockForChain(
        rootBundle as ProposedRootBundle,
        chain,
        chainIdList
      );

      // If chain list doesn't contain chain, then bundleEvalBlockNumber returns 0 and the following check
      // always fails.
      if (bundleEvalBlockNumber >= block) {
        endingBlockNumber = bundleEvalBlockNumber;
        // Since events are sorted from oldest to newest, and bundle block ranges should only increase, exit as soon
        // as we find the first block range that contains the target block.
        break;
      }
    }
    return endingBlockNumber;
  }

  getMostRecentProposedRootBundle(latestBlockToSearch: number) {
    return sortEventsDescending(this.proposedRootBundles).find(
      (proposedRootBundle: ProposedRootBundle) => proposedRootBundle.blockNumber <= latestBlockToSearch
    ) as ProposedRootBundle;
  }

  getFollowingRootBundle(currentRootBundle: ProposedRootBundle) {
    return sortEventsAscending(this.proposedRootBundles).find(
      (_rootBundle: ProposedRootBundle) => _rootBundle.blockNumber > currentRootBundle.blockNumber
    ) as ProposedRootBundle;
  }

  getExecutedLeavesForRootBundle(rootBundle: ProposedRootBundle, latestMainnetBlockToSearch: number) {
    return sortEventsAscending(this.executedRootBundles).filter(
      (executedLeaf: ExecutedRootBundle) =>
        executedLeaf.blockNumber <= latestMainnetBlockToSearch &&
        // Note: We can use > instead of >= here because a leaf can never be executed in same block as its root
        // proposal due to bundle liveness enforced by HubPool. This importantly avoids the edge case
        // where the execution all leaves occurs in the same block as the next proposal, leading us to think
        // that the next proposal is fully executed when its not.
        executedLeaf.blockNumber > rootBundle.blockNumber
    ) as ExecutedRootBundle[];
  }

  getLatestFullyExecutedRootBundle(latestMainnetBlock: number): ProposedRootBundle | undefined {
    // Search for latest ProposeRootBundleExecuted event followed by all of its RootBundleExecuted event suggesting
    // that all pool rebalance leaves were executed. This ignores any proposed bundles that were partially executed.
    return sortEventsDescending(this.proposedRootBundles).find((rootBundle: ProposedRootBundle) => {
      if (rootBundle.blockNumber > latestMainnetBlock) return false;
      return this.isRootBundleValid(rootBundle, latestMainnetBlock);
    });
  }

  getNextBundleStartBlockNumber(chainIdList: number[], latestMainnetBlock: number, chainId: number): number {
    const latestFullyExecutedPoolRebalanceRoot = this.getLatestFullyExecutedRootBundle(latestMainnetBlock);

    // If no event, then we can return a conservative default starting block like 0,
    // or we could throw an Error.
    if (!latestFullyExecutedPoolRebalanceRoot) return 0;

    // Once this proposal event is found, determine its mapping of indices to chainId in its
    // bundleEvaluationBlockNumbers array using CHAIN_ID_LIST. For each chainId, their starting block number is that
    // chain's bundleEvaluationBlockNumber + 1 in this past proposal event.
    const endBlock = this.getBundleEndBlockForChain(latestFullyExecutedPoolRebalanceRoot, chainId, chainIdList);

    // If `chainId` either doesn't exist in the chainIdList, or is at an index that doesn't exist in the root bundle
    // event's bundle block range (e.g. bundle block range has two entries, chain ID list has three, and chain matches
    // third entry), return 0 to indicate we want to get all history for this chain that we haven't seen before.

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
      )
        throw new Error("runningBalances and L1 token of ExecutedRootBundle event are not same length");
      const indexOfL1Token = mostRecentExecutedRootBundleEvent.l1Tokens
        .map((l1Token) => l1Token.toLowerCase())
        .indexOf(l1Token.toLowerCase());
      return mostRecentExecutedRootBundleEvent.runningBalances[indexOfL1Token];
    } else return toBN(0);
  }

  async update() {
    this.latestBlockNumber = await this.hubPool.provider.getBlockNumber();
    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || this.latestBlockNumber,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    this.logger.debug({ at: "HubPoolClient", message: "Updating client", searchConfig });
    if (searchConfig.fromBlock > searchConfig.toBlock) return; // If the starting block is greater than the ending block return.

    const [
      poolRebalanceRouteEvents,
      l1TokensLPEvents,
      proposeRootBundleEvents,
      executedRootBundleEvents,
      crossChainContractsSetEvents,
      pendingRootBundleProposal,
      currentTime,
    ] = await Promise.all([
      paginatedEventQuery(this.hubPool, this.hubPool.filters.SetPoolRebalanceRoute(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.L1TokenEnabledForLiquidityProvision(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.ProposeRootBundle(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.RootBundleExecuted(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.CrossChainContractsSet(), searchConfig),
      this.hubPool.rootBundleProposal(),
      this.hubPool.getCurrentTime(),
    ]);

    this.currentTime = currentTime;

    for (const event of crossChainContractsSetEvents) {
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

    for (const event of poolRebalanceRouteEvents) {
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
    const tokenInfo: L1Token[] = await Promise.all(
      l1TokensLPEvents.map((event) => this.fetchTokenInfoFromContract(spreadEvent(event).l1Token))
    );
    for (const info of tokenInfo) if (!this.l1Tokens.includes(info)) this.l1Tokens.push(info);

    this.proposedRootBundles.push(
      ...proposeRootBundleEvents.map((event) => spreadEventWithBlockNumber(event) as ProposedRootBundle)
    );
    this.executedRootBundles.push(
      ...executedRootBundleEvents.map((event) => spreadEventWithBlockNumber(event) as ExecutedRootBundle)
    );

    this.pendingRootBundle = {
      poolRebalanceRoot: pendingRootBundleProposal.poolRebalanceRoot,
      relayerRefundRoot: pendingRootBundleProposal.relayerRefundRoot,
      slowRelayRoot: pendingRootBundleProposal.slowRelayRoot,
      proposer: pendingRootBundleProposal.proposer,
      unclaimedPoolRebalanceLeafCount: pendingRootBundleProposal.unclaimedPoolRebalanceLeafCount,
      challengePeriodEndTimestamp: pendingRootBundleProposal.challengePeriodEndTimestamp,
      bundleEvaluationBlockNumbers: undefined,
      proposalBlockNumber: undefined,
    };
    // If pending proposal is active, even if it passed the liveness period, then we can load the following root
    // bundle properties: `bundleEvaluationBlockNumbers` and `proposalBlockNumber`, otherwise they are not relevant.
    // We can assume that the pool rebalance root is never empty if there is a pending root on-chain, regardless
    // if the root is disputable.
    if (this.pendingRootBundle.poolRebalanceRoot !== EMPTY_MERKLE_ROOT) {
      // Throw an error if this client is configured in such a way that the most recent event does not match
      // the pending root bundle. We should handle this case eventually, but for now loudly error so we don't dispute
      // the wrong pending bundle.
      const mostRecentProposedRootBundle = sortEventsDescending(this.proposedRootBundles)[0];
      if (
        mostRecentProposedRootBundle.poolRebalanceRoot !== this.pendingRootBundle.poolRebalanceRoot &&
        mostRecentProposedRootBundle.relayerRefundRoot !== this.pendingRootBundle.relayerRefundRoot &&
        mostRecentProposedRootBundle.slowRelayRoot !== this.pendingRootBundle.slowRelayRoot
      )
        throw new Error("Latest root bundle queried by client does not match pending root bundle");

      this.pendingRootBundle.bundleEvaluationBlockNumbers =
        mostRecentProposedRootBundle.bundleEvaluationBlockNumbers.map((block: BigNumber) => block.toNumber());
      this.pendingRootBundle.proposalBlockNumber = mostRecentProposedRootBundle.blockNumber;
    }

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig.toBlock + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "HubPoolClient", message: "Client updated!" });
  }

  private async fetchTokenInfoFromContract(address: string): Promise<L1Token> {
    const token = new Contract(address, ERC20.abi, this.hubPool.signer);
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    return { address, symbol, decimals };
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
    if (chainIdIndex === -1) return 0;
    // Sometimes, the root bundle event's chain ID list will update from bundle to bundle, so we need to check that
    // the bundle evaluation block number list is long enough to contain this index. We assume that chain ID's
    // are only added to the bundle block list, never deleted.
    if (chainIdIndex >= bundleEvaluationBlockNumbers.length) return 0;
    return bundleEvaluationBlockNumbers[chainIdIndex].toNumber();
  }
}
