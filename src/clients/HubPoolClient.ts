import { assign, Contract, winston, BigNumber, ERC20, sortEventsAscending, toBN, sortEventsDescending } from "../utils";
import { spreadEvent, spreadEventWithBlockNumber } from "../utils";
import { Deposit, L1Token, ProposedRootBundle, ExecutedRootBundle } from "../interfaces";

export class HubPoolClient {
  // L1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: { [l1Token: string]: { [destinationChainId: number]: string } } = {};
  private l1Tokens: L1Token[] = []; // L1Tokens and their associated info.
  private proposedRootBundles: ProposedRootBundle[] = [];
  private executedRootBundles: ExecutedRootBundle[] = [];
  private l1TokensToDestinationTokensWithBlock: {
    [l1Token: string]: { [destinationChainId: number]: [{ l2Token: string; block: number }] };
  } = {};

  public isUpdated: boolean = false;
  public firstBlockToSearch: number;

  constructor(
    readonly logger: winston.Logger,
    readonly hubPool: Contract,
    readonly startingBlock: number = 0,
    readonly endingBlock: number | null = null
  ) {}

  getDestinationTokenForDeposit(deposit: Deposit) {
    const l1Token = this.getL1TokenForDeposit(deposit);
    const destinationToken = this.getDestinationTokenForL1TokenDestinationChainId(l1Token, deposit.destinationChainId);
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
      // We assume that l2-l1 token mapping events are sorted in descending order, so find the last mapping published
      // before the target block.
      return this.l1TokensToDestinationTokensWithBlock[_l1Token][l2ChainId].find(
        (mapping: { l2Token: string; block: number }) => mapping.l2Token === l2Token && mapping.block <= block
      );
    });
    if (!l1Token)
      throw new Error(
        `Could not find L1 token mapping for chain ${l2ChainId} and L2 token ${l2Token} equal to or earlier than block ${block}!`
      );
    return l1Token;
  }

  getDestinationTokenForL1TokenDestinationChainId(l1Token: string, destinationChainId: number) {
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
      const bundleEvaluationBlockNumbers: BigNumber[] = (rootBundle as ProposedRootBundle).bundleEvaluationBlockNumbers;
      if (bundleEvaluationBlockNumbers.length !== chainIdList.length)
        throw new Error("Chain ID list and bundle block eval range list length do not match");
      const chainIdIndex = chainIdList.indexOf(chain);
      if (chainIdIndex === -1) throw new Error("Can't find fill.destinationChainId in CHAIN_ID_LIST");
      if (bundleEvaluationBlockNumbers[chainIdIndex].gte(toBN(block))) {
        endingBlockNumber = bundleEvaluationBlockNumbers[chainIdIndex].toNumber();
        // Since events are sorted from oldest to newest, and bundle block ranges should only increase, exit as soon
        // as we find the first block range that contains the target block.
        break;
      }
    }
    return endingBlockNumber;
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
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.hubPool.provider.getBlockNumber())];
    this.logger.debug({ at: "HubPoolClient", message: "Updating client", searchConfig });
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.

    const [poolRebalanceRouteEvents, l1TokensLPEvents, proposeRootBundleEvents, executedRootBundleEvents] =
      await Promise.all([
        this.hubPool.queryFilter(this.hubPool.filters.SetPoolRebalanceRoute(), ...searchConfig),
        this.hubPool.queryFilter(this.hubPool.filters.L1TokenEnabledForLiquidityProvision(), ...searchConfig),
        this.hubPool.queryFilter(this.hubPool.filters.ProposeRootBundle(), ...searchConfig),
        this.hubPool.queryFilter(this.hubPool.filters.RootBundleExecuted(), ...searchConfig),
      ]);

    for (const event of poolRebalanceRouteEvents) {
      const args = spreadEvent(event);
      assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], args.destinationToken);
      assign(
        this.l1TokensToDestinationTokensWithBlock,
        [args.l1Token, args.destinationChainId],
        [{ l2Token: args.destinationToken, block: event.blockNumber }]
      );
      // Sort l2 token to l1 token mapping events in descending order so we can easily find the first mapping update
      // equal to or earlier than a target block. This allows a caller to look up the l1 token counterpart for an l2
      // token at a specific block height.
      this.l1TokensToDestinationTokensWithBlock[args.l1Token][args.destinationChainId].sort(
        (mappingA: { block: number }, mappingB: { block: number }) => {
          return mappingB.block - mappingA.block;
        }
      );
    }

    // For each enabled Lp token fetch the token symbol and decimals from the token contract. Note this logic will
    // only run iff a new token has been enabled. Will only append iff the info is not there already.
    const tokenInfo = await Promise.all(
      l1TokensLPEvents.map((event) => this.fetchTokenInfoFromContract(spreadEvent(event).l1Token))
    );
    for (const info of tokenInfo) if (!this.l1Tokens.includes(info)) this.l1Tokens.push(info);

    this.proposedRootBundles.push(...proposeRootBundleEvents.map((event) => spreadEventWithBlockNumber(event)));
    this.executedRootBundles.push(...executedRootBundleEvents.map((event) => spreadEventWithBlockNumber(event)));

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig[1] + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "HubPoolClient", message: "Client updated!" });
  }

  private async fetchTokenInfoFromContract(address: string): Promise<L1Token> {
    const token = new Contract(address, ERC20.abi, this.hubPool.signer);
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    return { address, symbol, decimals };
  }
}
