import { spreadEvent, assign, Contract, toBNWei, BigNumber, toBN } from "./utils";
import { Deposit, Fill, SpeedUp } from "./interfaces/SpokePool";
import { destinationChainId } from "../test/utils";

import { lpFeeCalculator } from "@across-protocol/sdk-v2";

export class HubPoolEventClient {
  // l1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: { [l1Token: string]: { [destinationChainId: number]: string } } = {};

  public firstBlockToSearch: number;

  constructor(
    readonly hubPool: Contract,
    readonly startingBlock: number = 0,
    readonly endingBlock: number | null = null
  ) {}

  async computeRealizedLpFeePctForDeposit(deposit: Deposit) {
    // TODO: implement this method.
    return toBNWei(0.1);
  }

  getDestinationTokenForDeposit(deposit: Deposit) {
    const l1Token = this.getL1TokenForDeposit(deposit);
    return this.getDestinationTokenForL1TokenAndDestinationChainId(l1Token, deposit.destinationChainId);
  }

  getL1TokensToDestinationTokens() {
    return this.l1TokensToDestinationTokens;
  }

  getL1TokenForDeposit(deposit: Deposit) {
    let l1Token = null;
    Object.keys(this.l1TokensToDestinationTokens).forEach((key) => {
      if (this.l1TokensToDestinationTokens[key][deposit.originChainId.toString()] === deposit.originToken)
        l1Token = key;
    });
    return l1Token;
  }

  getDestinationTokenForL1TokenAndDestinationChainId(l1Token: string, destinationChainId: number) {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId];
  }

  validateFillForDeposit(fill: Fill, deposit: Deposit) {
    // TODO: this method should validate the realizedLpFeePct and the destinationToken for the fill->deposit relationship.
    return true;
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.getBlockNumber())];
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.
    const [PoolRebalanceRouteEvents] = await Promise.all([
      await this.hubPool.queryFilter(this.hubPool.filters.SetPoolRebalanceRoute()),
    ]);

    for (const event of PoolRebalanceRouteEvents) {
      const args = spreadEvent(event);
      assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], args.destinationToken);
    }
  }

  private async getBlockNumber(): Promise<number> {
    return await this.hubPool.provider.getBlockNumber();
  }
}
