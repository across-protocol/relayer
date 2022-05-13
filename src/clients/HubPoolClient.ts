import { assign, Contract, winston, BigNumber, ERC20, sortEventsAscending, EventSearchConfig, toBN } from "../utils";
import { sortEventsDescending, spreadEvent, spreadEventWithBlockNumber, paginatedEventQuery } from "../utils";
import { Deposit, L1Token, ProposedRootBundle, ExecutedRootBundle } from "../interfaces";
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

  public isUpdated: boolean = false;
  public firstBlockToSearch: number;
  public latestBlockNumber: number;

  constructor(
    readonly logger: winston.Logger,
    readonly hubPool: Contract,
    readonly eventSearchConfig: EventSearchConfig = { fromBlock: 0, toBlock: null, maxBlockLookBack: 0 }
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
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
    if (!destinationToken) this.logger.error({ at: "HubPoolClient", message: "No destination token found", deposit });
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
    if (l1Token === null) throw new Error(`Could not find L1 Token for deposit!,${JSON.stringify(deposit)}`);
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
    const blockOffset = { blockTag: quoteBlockNumber };
    const [current, post] = await Promise.all([
      this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token, blockOffset),
      this.hubPool.callStatic.liquidityUtilizationPostRelay(l1Token, relaySize, blockOffset),
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

  // This should find the ProposeRootBundle event whose bundle block number for `chain` is closest to the `block`
  // without being smaller. It returns the bundle block number for the chain.
  getRootBundleEvalBlockNumberContainingBlock(block: number, chain: number, chainIdList: number[]): number | undefined {
    let endingBlockNumber: number;
    for (const rootBundle of sortEventsAscending(this.proposedRootBundles)) {
      const bundleEvalBlockNumber = this.getBundleEndBlockForChain(
        rootBundle as ProposedRootBundle,
        chain,
        chainIdList
      );
      if (bundleEvalBlockNumber >= block) {
        endingBlockNumber = bundleEvalBlockNumber;
        // Since events are sorted from oldest to newest, and bundle block ranges should only increase, exit as soon
        // as we find the first block range that contains the target block.
        break;
      }
    }
    return endingBlockNumber;
  }

  getNextBundleStartBlockNumber(chainIdList: number[], latestBlock: number, chainId: number): number {
    // Search for the latest RootBundleExecuted event with a matching chainId while still being earlier than the
    // latest block.
    const latestRootBundleExecutedEvent = sortEventsDescending(this.executedRootBundles).find(
      (event: ExecutedRootBundle) => event.blockNumber <= latestBlock && event.chainId === chainId
    );

    // TODO: If no event for chain ID, then we can return a conservative default starting block like 0,
    // or we could throw an Error.
    if (!latestRootBundleExecutedEvent) return 0;

    // Once that event is found, search for the ProposeRootBundle event that is as late as possible, but earlier than
    // the RootBundleExecuted event we just identified.
    const mostRecentProposeRootBundleEventWithChain = sortEventsDescending(this.proposedRootBundles).find(
      (rootBundle: ProposedRootBundle) => rootBundle.blockNumber <= latestRootBundleExecutedEvent.blockNumber
    ) as ProposedRootBundle;

    // Same situation as when we cannot find a ExecutedRootBundleEvent, if we can't find a ProposedRootBundle
    // event, then either return 0 or throw an error.
    if (!mostRecentProposeRootBundleEventWithChain) return 0;

    // Once this proposal event is found, determine its mapping of indices to chainId in its
    // bundleEvaluationBlockNumbers array using CHAIN_ID_LIST. For each chainId, their starting block number is that
    // chain's bundleEvaluationBlockNumber + 1 in this past proposal event.
    return this.getBundleEndBlockForChain(mostRecentProposeRootBundleEventWithChain, chainId, chainIdList) + 1;
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
    ] = await Promise.all([
      paginatedEventQuery(this.hubPool, this.hubPool.filters.SetPoolRebalanceRoute(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.L1TokenEnabledForLiquidityProvision(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.ProposeRootBundle(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.RootBundleExecuted(), searchConfig),
      paginatedEventQuery(this.hubPool, this.hubPool.filters.CrossChainContractsSet(), searchConfig),
    ]);

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
    const tokenInfo = await Promise.all(
      l1TokensLPEvents.map((event) => this.fetchTokenInfoFromContract(spreadEvent(event).l1Token))
    );
    for (const info of tokenInfo) if (!this.l1Tokens.includes(info)) this.l1Tokens.push(info);

    this.proposedRootBundles.push(
      ...proposeRootBundleEvents.map((event) => spreadEventWithBlockNumber(event) as ProposedRootBundle)
    );
    this.executedRootBundles.push(
      ...executedRootBundleEvents.map((event) => spreadEventWithBlockNumber(event) as ExecutedRootBundle)
    );

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig.toBlock + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "HubPoolClient", message: "Client updated!" });
  }

  private async fetchTokenInfoFromContract(address: string): Promise<L1Token> {
    const token = new Contract(address, ERC20.abi, this.hubPool.signer);
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    return { address, symbol, decimals };
  }

  private getBundleEndBlockForChain(
    proposeRootBundleEvent: ProposedRootBundle,
    chainId: number,
    chainIdList: number[]
  ): number {
    const bundleEvaluationBlockNumbers: BigNumber[] = proposeRootBundleEvent.bundleEvaluationBlockNumbers;
    if (bundleEvaluationBlockNumbers.length !== chainIdList.length)
      throw new Error("Chain ID list and bundle block eval range list length do not match");
    const chainIdIndex = chainIdList.indexOf(chainId);
    if (chainIdIndex === -1) throw new Error(`Can't find chainId ${chainId} in chainIdList ${chainIdList}`);
    return bundleEvaluationBlockNumbers[chainIdIndex].toNumber();
  }
}
