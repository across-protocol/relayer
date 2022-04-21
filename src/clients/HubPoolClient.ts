import { spreadEvent, assign, Contract, winston, BigNumber, ERC20, Event, sortEventsAscending, toBN } from "../utils";
import { Deposit, Fill, L1Token } from "../interfaces";
import { SpokePoolClient, CHAIN_ID_LIST_INDICES } from ".";

export class HubPoolClient {
  // L1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: { [l1Token: string]: { [destinationChainId: number]: string } } = {};
  private l1Tokens: L1Token[] = []; // L1Tokens and their associated info.
  private proposeRootBundleEvents: Event[] = [];
  private executeRootBundleEvents: Event[] = [];

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

  getL1TokenCounterpart(repaymentChainId: string, l2Token: string) {
    let l1Token = null;
    Object.keys(this.l1TokensToDestinationTokens).forEach((_l1Token) => {
      if (this.l1TokensToDestinationTokens[_l1Token][repaymentChainId] === l2Token) l1Token = _l1Token;
    });
    if (l1Token === null)
      throw new Error(`Could not find L1 Token for repayment chain ${repaymentChainId} and L2 token ${l2Token}!`);
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

  // TODO:
  // Query CrossChainContractsSet events to find spoke pools at specified `block`.
  // getCrossChainContractsForBlock(block:number): { [chainId: number]: SpokePoolClient } {
  // }

  // // Returns an ordered array of block ranges for each spoke pool. For an ordered list of `toBlocks`, this function
  // // will find the corresponding `fromBlocks` for each chain. The order of chains can be found in CHAIN_ID_LIST.
  // getRootBundleEvaluationBlockRange(toBlocks: number[]): number[][] {
  //   // Find latest RootBundleExecuted event with matching chain ID while still being earlier than the toBlock.
  //   const blockRanges: number[][] = toBlocks.map((block, i) => {
  //     const chainId = CHAIN_ID_LIST_INDICES[i]
  //     // Sort event block heights from latest to earliest, so we find the events right before our target block.
  //     const precedingExecuteRootBundleEvent: Event = this.executeRootBundleEvents.sort((ex, ey) => ey.blockNumber - ex.blockNumber).find(
  //       (e: Event) => e.args.chainId === chainId && e.blockNumber < block
  //     );
  //     const precedingProposeRootBundleEvent: Event = this.proposeRootBundleEvents.sort((ex, ey) => ey.blockNumber - ex.blockNumber).find(
  //       (e: Event) => e.blockNumber < precedingExecuteRootBundleEvent.blockNumber
  //     );
  //   })
  // }

  // This should find the ProposeRootBundle event whose bundle block number for `chain` is closest to the `block`
  // without being smaller. It returns the bundle block number for the chain.
  getRootBundleEvalBlockNumberContainingBlock(block: number, chain: number, chainIdList: number[]): number {
    let endingBlockNumber: number;
    sortEventsAscending(this.proposeRootBundleEvents).forEach((e: Event) => {
      const bundleEvaluationBlockNumbers: BigNumber[] = e.args.bundleEvaluationBlockNumbers;
      if (bundleEvaluationBlockNumbers.length !== chainIdList.length)
        throw new Error("Chain ID list and bundle block eval range list length do not match");
      const chainIdIndex = chainIdList.indexOf(chain);
      if (chainIdIndex === -1) throw new Error("Can't find fill.destinationChainId in CHAIN_ID_LIST");
      if (bundleEvaluationBlockNumbers[chainIdIndex].gt(toBN(block)))
        endingBlockNumber = bundleEvaluationBlockNumbers[chainIdIndex].toNumber();
    });
    if (!endingBlockNumber) throw new Error("Can't find ProposeRootBundle event containing block");
    return endingBlockNumber;
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.hubPool.provider.getBlockNumber())];
    this.logger.debug({ at: "HubPoolClient", message: "Updating client", searchConfig });
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.

    const [poolRebalanceRouteEvents, l1TokensLPEvents, proposeRootBundleEvents, executeRootBundleEvents] =
      await Promise.all([
        this.hubPool.queryFilter(this.hubPool.filters.SetPoolRebalanceRoute(), ...searchConfig),
        this.hubPool.queryFilter(this.hubPool.filters.L1TokenEnabledForLiquidityProvision(), ...searchConfig),
        this.hubPool.queryFilter(this.hubPool.filters.ProposeRootBundle(), ...searchConfig),
        this.hubPool.queryFilter(this.hubPool.filters.RootBundleExecuted(), ...searchConfig),
      ]);

    for (const event of poolRebalanceRouteEvents) {
      const args = spreadEvent(event);
      assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], args.destinationToken);
    }

    // For each enabled Lp token fetch the token symbol and decimals from the token contract. Note this logic will
    // only run iff a new token has been enabled. Will only append iff the info is not there already.
    const tokenInfo = await Promise.all(
      l1TokensLPEvents.map((event) => this.fetchTokenInfoFromContract(spreadEvent(event).l1Token))
    );
    for (const info of tokenInfo) if (!this.l1Tokens.includes(info)) this.l1Tokens.push(info);

    this.proposeRootBundleEvents.push(...proposeRootBundleEvents);
    this.executeRootBundleEvents.push(...executeRootBundleEvents);

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
