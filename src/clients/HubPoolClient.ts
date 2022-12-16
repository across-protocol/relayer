import {
  assign,
  Contract,
  winston,
  BigNumber,
  ERC20,
  sortEventsAscending,
  EventSearchConfig,
  MakeOptional,
  ethers,
  Block,
  getCurrentTime,
} from "../utils";
import { sortEventsDescending, spreadEvent, spreadEventWithBlockNumber, paginatedEventQuery, toBN } from "../utils";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";
import { Deposit, L1Token, CancelledRootBundle, DisputedRootBundle, LpToken, SpokePoolProviders } from "../interfaces";
import { ExecutedRootBundle, PendingRootBundle, ProposedRootBundle } from "../interfaces";
import { CrossChainContractsSet, DestinationTokenWithBlock, SetPoolRebalanceRoot } from "../interfaces";
import _ from "lodash";
import { createClient } from "redis4";
import { BlockFinder } from "@uma/sdk";

type RedisClient = ReturnType<typeof createClient>;

export class HubPoolClient {
  // L1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: { [l1Token: string]: { [destinationChainId: number]: string } } = {};
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
  private l2BlockFinders: { [chainId: number]: BlockFinder<Block> } = {};

  public isUpdated = false;
  public firstBlockToSearch: number;
  public latestBlockNumber: number | undefined;
  public currentTime: number | undefined;

  constructor(
    readonly logger: winston.Logger,
    readonly hubPool: Contract,
    readonly hubPoolChainId: number,
    readonly spokePoolProviders: SpokePoolProviders,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    readonly redisClient?: RedisClient
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
  }

  getProvider(): ethers.providers.Provider {
    return this.hubPool.provider;
  }

  setProvider(chainId: number, provider: ethers.providers.Provider): void {
    this.spokePoolProviders[chainId] = provider;
  }

  hasPendingProposal() {
    return this.pendingRootBundle !== undefined;
  }

  getPendingRootBundle() {
    return this.pendingRootBundle;
  }

  getProposedRootBundles() {
    return this.proposedRootBundles;
  }

  getCancelledRootBundles() {
    return this.canceledRootBundles;
  }

  getDisputedRootBundles() {
    return this.disputedRootBundles;
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

  // Return SpokePools set as CrossChainContracts on HubPool before block.
  getActiveSpokePoolsForBlocks(
    searchConfig: { fromBlock: number; toBlock: number },
    chainId: number
  ): CrossChainContractsSet[] {
    // Get the most recent CrossChainContractsSet before the fromBlock. This is the first SpokePool for this chain
    // that was enabled for the searchConfig.
    const mostRecentSpokePoolUpdateBeforeFromBlock = sortEventsDescending(this.crossChainContracts[chainId]).find(
      (spokePool) => spokePool.validSearchRange.fromBlock <= searchConfig.fromBlock
    );
    if (!mostRecentSpokePoolUpdateBeforeFromBlock?.validSearchRange?.fromBlock) return [];

    // Return all CrossChainContractsSet events after the most recent CrossChainContractsSet before the fromBlock
    // until we get one that happened after the toBlock.
    const activeSpokePools = sortEventsAscending(this.crossChainContracts[chainId])
      .filter((spokePool) => {
        return (
          spokePool.validSearchRange.fromBlock >= mostRecentSpokePoolUpdateBeforeFromBlock.validSearchRange.fromBlock &&
          spokePool.validSearchRange.fromBlock <= searchConfig.toBlock
        );
      })
      // If consecutive spoke pool upgrades are for the same contract address, then squash them together.
      .reduce((activeSpokePools: CrossChainContractsSet[], activeSpokePoolCurr: CrossChainContractsSet, i) => {
        if (i === 0) return [activeSpokePoolCurr];
        if (activeSpokePoolCurr.spokePool === activeSpokePools[activeSpokePools.length - 1].spokePool)
          activeSpokePools[activeSpokePools.length - 1].validSearchRange.toBlock =
            activeSpokePoolCurr.validSearchRange.toBlock;
        else activeSpokePools.push(activeSpokePoolCurr);
        return activeSpokePools;
      }, []);
    return activeSpokePools;
  }

  getDestinationTokenForDeposit(deposit: { originChainId: number; originToken: string; destinationChainId: number }) {
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

  getL1TokenForDeposit(deposit: { originChainId: number; originToken: string }) {
    let l1Token = null;
    Object.keys(this.l1TokensToDestinationTokens).forEach((_l1Token) => {
      if (this.l1TokensToDestinationTokens[_l1Token][deposit.originChainId] === deposit.originToken) l1Token = _l1Token;
    });
    if (l1Token === null)
      throw new Error(
        `Could not find L1 Token for origin chain ${deposit.originChainId} and origin token ${deposit.originToken}!`
      );
    return l1Token;
  }

  getL1TokenCounterpartAtBlock(l2ChainId: number, l2Token: string, block: number) {
    const l1Token = Object.keys(this.l1TokensToDestinationTokensWithBlock).find((_l1Token) => {
      // If this token doesn't exist on this L2, return false.
      if (this.l1TokensToDestinationTokensWithBlock[_l1Token][l2ChainId] === undefined) return false;

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

  l2TokenEnabledForL1Token(l1Token: string, destinationChainId: number) {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId] != undefined;
  }
  getDestinationTokensToL1TokensForChainId(chainId: number) {
    return Object.fromEntries(
      this.l1Tokens
        .map((l1Token) => [this.getDestinationTokenForL1Token(l1Token.address, chainId), l1Token])
        .filter((entry) => entry[0] !== undefined)
    );
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
    for (const rootBundle of sortEventsAscending(this.proposedRootBundles)) {
      const nextRootBundle = this.getFollowingRootBundle(rootBundle);
      if (!this.isRootBundleValid(rootBundle, nextRootBundle ? nextRootBundle.blockNumber : latestMainnetBlock))
        continue;

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

  // TODO: This might not be necessary since the cumulative root bundle count doesn't grow fast enough, but consider
  // using _.findLast/_.find instead of resorting the arrays if these functions begin to take a lot time.
  getProposedRootBundlesInBlockRange(startingBlock: number, endingBlock: number) {
    return sortEventsDescending(this.proposedRootBundles).filter(
      (bundle: ProposedRootBundle) => bundle.blockNumber >= startingBlock && bundle.blockNumber <= endingBlock
    );
  }

  getCancelledRootBundlesInBlockRange(startingBlock: number, endingBlock: number) {
    return sortEventsDescending(this.canceledRootBundles).filter(
      (bundle: CancelledRootBundle) => bundle.blockNumber >= startingBlock && bundle.blockNumber <= endingBlock
    );
  }

  getDisputedRootBundlesInBlockRange(startingBlock: number, endingBlock: number) {
    return sortEventsDescending(this.disputedRootBundles).filter(
      (bundle: DisputedRootBundle) => bundle.blockNumber >= startingBlock && bundle.blockNumber <= endingBlock
    );
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
    return _.findLast(this.proposedRootBundles, (rootBundle: ProposedRootBundle) => {
      if (rootBundle.blockNumber > latestMainnetBlock) return false;
      return this.isRootBundleValid(rootBundle, latestMainnetBlock);
    });
  }

  getEarliestFullyExecutedRootBundle(latestMainnetBlock: number, startBlock = 0): ProposedRootBundle | undefined {
    return this.proposedRootBundles.find((rootBundle: ProposedRootBundle) => {
      if (rootBundle.blockNumber > latestMainnetBlock) return false;
      if (rootBundle.blockNumber < startBlock) return false;
      return this.isRootBundleValid(rootBundle, latestMainnetBlock);
    });
  }

  // If n is negative, then return the Nth latest executed bundle, otherwise return the Nth earliest
  // executed bundle. Latest means most recent, earliest means oldest. N cannot be 0.
  // `startBlock` can be used to set the starting point from which we look forwards or backwards, depending
  // on whether n is positive or negative.
  getNthFullyExecutedRootBundle(n: number, startBlock?: number): ProposedRootBundle | undefined {
    if (n === 0) throw new Error("n cannot be 0");
    if (!this.latestBlockNumber) throw new Error("HubPoolClient::getNthFullyExecutedRootBundle client not updated");

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
    this.latestBlockNumber = await this.getProvider().getBlockNumber();
    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || this.latestBlockNumber,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    this.logger.debug({ at: "HubPoolClient", message: "Updating HubPool client", searchConfig });
    if (searchConfig.fromBlock > searchConfig.toBlock) return; // If the starting block is greater than the ending block return.

    const [
      poolRebalanceRouteEvents,
      l1TokensLpEvents,
      proposeRootBundleEvents,
      canceledRootBundleEvents,
      disputedRootBundleEvents,
      executedRootBundleEvents,
      crossChainContractsSetEvents,
      pendingRootBundleProposal,
      currentTime,
    ] = await Promise.all([
      paginatedEventQuery(this.hubPool, this.hubPool.filters.SetPoolRebalanceRoute(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.L1TokenEnabledForLiquidityProvision(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.ProposeRootBundle(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.RootBundleCanceled(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.RootBundleDisputed(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.RootBundleExecuted(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.CrossChainContractsSet(), searchConfig),
      this.hubPool.rootBundleProposal(),
      this.hubPool.getCurrentTime(),
    ]);

    this.currentTime = currentTime;

    const l2BlockEquivalents = await Promise.all(
      crossChainContractsSetEvents.map((event) => {
        const args = spreadEventWithBlockNumber(event) as CrossChainContractsSet;
        return this.getL2EquivalentBlockNumber(args.blockNumber, args.l2ChainId);
      })
    );
    for (let i = 0; i < crossChainContractsSetEvents.length; i++) {
      const event = crossChainContractsSetEvents[i];
      const args = spreadEventWithBlockNumber(event) as CrossChainContractsSet;
      assign(
        this.crossChainContracts,
        [args.l2ChainId],
        [
          {
            spokePool: args.spokePool,
            l2BlockEquivalent: l2BlockEquivalents[i],
            validSearchRange: { fromBlock: l2BlockEquivalents[i], toBlock: l2BlockEquivalents[i] },
            blockNumber: args.blockNumber,
            transactionIndex: args.transactionIndex,
            logIndex: args.logIndex,
          },
        ]
      );
    }

    // Now update the most recent cross chain contract's valid search range now that we know when it was
    // deactivated.
    // Invariant: The most recent spoke pool activated for a chainId must have a `null` toBlock.
    Object.entries(this.crossChainContracts).forEach(([chainId, crossChainContracts]) => {
      for (let i = 0; i < crossChainContracts.length - 1; i++) {
        if (crossChainContracts[i].validSearchRange.toBlock < crossChainContracts[i + 1].validSearchRange.fromBlock)
          crossChainContracts[i].validSearchRange.toBlock = crossChainContracts[i + 1].validSearchRange.fromBlock - 1;
      }
      if (crossChainContracts.length > 0)
        this.crossChainContracts[chainId][crossChainContracts.length - 1].validSearchRange.toBlock = null;
    });

    console.log(
      "Valid search configs:",
      JSON.stringify(
        Object.entries(this.crossChainContracts).map(([chainId, crossChainContracts]) => {
          return {
            chainId,
            crossChainContracts: crossChainContracts.map((crossChainContract) => {
              return {
                spokePool: crossChainContract.spokePool,
                validSearchRange: crossChainContract.validSearchRange,
              };
            }),
          };
        }),
        null,
        2
      )
    );

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
    // Filter out any duplicate addresses. This might happen due to enabling, disabling and re-enabling a token.
    const uniqueL1Tokens = [...new Set(l1TokensLpEvents.map((event) => spreadEvent(event).l1Token))];
    const [tokenInfo, lpTokenInfo] = await Promise.all([
      Promise.all(uniqueL1Tokens.map((l1Token: string) => this.fetchTokenInfoFromContract(l1Token))),
      Promise.all(uniqueL1Tokens.map(async (l1Token: string) => await this.hubPool.pooledTokens(l1Token))),
    ]);
    for (const info of tokenInfo) {
      if (!this.l1Tokens.find((token) => token.symbol === info.symbol)) {
        if (info.decimals > 0 && info.decimals <= 18) this.l1Tokens.push(info);
        else throw new Error(`Unsupported HubPool token: ${JSON.stringify(info)}`);
      }
    }

    uniqueL1Tokens.forEach((token: string, i) => {
      this.lpTokens[token] = { lastLpFeeUpdate: lpTokenInfo[i].lastLpFeeUpdate };
    });

    this.proposedRootBundles.push(
      ...proposeRootBundleEvents
        .filter((event) => !IGNORED_HUB_PROPOSED_BUNDLES.includes(event.blockNumber))
        .map((event) => {
          return { ...spreadEventWithBlockNumber(event), transactionHash: event.transactionHash } as ProposedRootBundle;
        })
    );
    this.canceledRootBundles.push(
      ...canceledRootBundleEvents.map((event) => spreadEventWithBlockNumber(event) as CancelledRootBundle)
    );
    this.disputedRootBundles.push(
      ...disputedRootBundleEvents.map((event) => spreadEventWithBlockNumber(event) as DisputedRootBundle)
    );
    this.executedRootBundles.push(
      ...executedRootBundleEvents
        .filter((event) => !IGNORED_HUB_EXECUTED_BUNDLES.includes(event.blockNumber))
        .map((event) => spreadEventWithBlockNumber(event) as ExecutedRootBundle)
    );

    // If the contract's current rootBundleProposal() value has an unclaimedPoolRebalanceLeafCount > 0, then
    // it means that either the root bundle proposal is in the challenge period and can be disputed, or it has
    // passed the challenge period and pool rebalance leaves can be executed. Once all leaves are executed, the
    // unclaimed count will drop to 0 and at that point there is nothing more that we can do with this root bundle
    // besides proposing another one.
    if (pendingRootBundleProposal.unclaimedPoolRebalanceLeafCount > 0) {
      const mostRecentProposedRootBundle = sortEventsDescending(this.proposedRootBundles)[0];
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

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig.toBlock + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "HubPoolClient", message: "HubPool client updated!" });
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

  private async getL2EquivalentBlockNumber(l1Block: number, chainId: number) {
    // If this function is called many times in one run, then its result should be cached.
    const l1Provider = this.getProvider();
    const timestamp = (await l1Provider.getBlock(l1Block)).timestamp;
    if (!this.l2BlockFinders[chainId]) {
      const l2Provider = this.spokePoolProviders[chainId];
      this.l2BlockFinders[chainId] = new BlockFinder(l2Provider.getBlock.bind(l2Provider));
    }
    if (!this.redisClient) {
      return (await this.l2BlockFinders[chainId].getBlockForTimestamp(timestamp)).number;
    }
    const key = `l2_${chainId}_block_number_${timestamp}`;
    const result = await this.redisClient.get(key);
    if (result === null) {
      const blockNumber = (await this.l2BlockFinders[chainId].getBlockForTimestamp(timestamp)).number;
      if (this.shouldCache(timestamp)) await this.redisClient.set(key, blockNumber.toString());
      return blockNumber;
    } else {
      return parseInt(result);
    }
  }

  // Avoid caching calls that are recent enough to be affected by things like reorgs.
  private shouldCache(eventTimestamp: number) {
    // Current time must be >= 5 minutes past the event timestamp for it to be stable enough to cache.
    return getCurrentTime() - eventTimestamp >= 300;
  }
}
