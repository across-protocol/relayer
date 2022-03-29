import { spreadEvent, assign, Contract, winston, BigNumber } from "../utils";
import { Deposit } from "../interfaces/SpokePool";

export class HubPoolClient {
  // l1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: { [l1Token: string]: { [destinationChainId: number]: string } } = {};
  private _isUpdated: boolean = false;

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
    if (!destinationToken)
      this.logger.error({ at: "HubPoolClient", message: "No destination token found for deposit", deposit });
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
    return l1Token;
  }

  getDestinationTokenForL1TokenDestinationChainId(l1Token: string, destinationChainId: number) {
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
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.hubPool.provider.getBlockNumber())];
    this.logger.debug({ at: "HubPoolClient", message: "Updating client", searchConfig });
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.

    const [poolRebalanceRouteEvents] = await Promise.all([
      this.hubPool.queryFilter(this.hubPool.filters.SetPoolRebalanceRoute(), ...searchConfig),
    ]);

    for (const event of poolRebalanceRouteEvents) {
      const args = spreadEvent(event);
      assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], args.destinationToken);
    }

    this._isUpdated = true;

    this.firstBlockToSearch = searchConfig[1] + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "HubPoolClient", message: "Client updated!" });
  }

  isUpdated(): Boolean {
    return this._isUpdated;
  }
}
