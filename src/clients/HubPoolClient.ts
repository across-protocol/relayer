import { spreadEvent, assign, Contract, BaseContract, toBNWei, Block, BigNumber, toBN, utils } from "../utils";
import { Deposit, Fill, SpeedUp } from "../interfaces/SpokePool";

export class HubPoolClient {
  // l1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: { [l1Token: string]: { [destinationChainId: number]: string } } = {};

  public firstBlockToSearch: number;

  constructor(
    readonly hubPool: Contract,
    readonly startingBlock: number = 0,
    readonly endingBlock: number | null = null
  ) {}

  getDestinationTokenForDeposit(deposit: Deposit) {
    const l1Token = this.getL1TokenForDeposit(deposit);
    return this.getDestinationTokenForL1TokenAndDestinationChainId(l1Token, deposit.destinationChainId);
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
    return l1Token;
  }

  getDestinationTokenForL1TokenAndDestinationChainId(l1Token: string, destinationChainId: number) {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId];
  }

  async getPoolUtilization(quoteBlockNumber: number, l1Token: string, amount: BigNumber) {
    const blockOffset = { blockTag: quoteBlockNumber };
    const [liquidityUtilizationCurrent, liquidityUtilizationPostRelay] = await Promise.all([
      this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token, blockOffset),
      this.hubPool.callStatic.liquidityUtilizationPostRelay(l1Token, amount.toString(), blockOffset),
    ]);
    return { liquidityUtilizationCurrent, liquidityUtilizationPostRelay };
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.getBlockNumber())];
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.
    const [poolRebalanceRouteEvents] = await Promise.all([
      this.hubPool.queryFilter(this.hubPool.filters.SetPoolRebalanceRoute(), ...searchConfig),
    ]);

    for (const event of poolRebalanceRouteEvents) {
      const args = spreadEvent(event);
      assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], args.destinationToken);
    }
  }

  async getBlockNumber(): Promise<number> {
    return await this.hubPool.provider.getBlockNumber();
  }

  getProvider() {
    return this.hubPool.provider;
  }

  isUpdated(): Boolean {
    return Object.keys(this.l1TokensToDestinationTokens).length > 0;
  }
}
