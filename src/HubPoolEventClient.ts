import { spreadEvent, assign, Contract, toBNWei, BigNumber, toBN } from "./utils";
import { Deposit, Fill, SpeedUp } from "./interfaces/SpokePool";
import { destinationChainId } from "../test/utils";

export class HubPoolEventClient {
  private whitelistedRoutes: {
    [originChainId: number]: { [originToken: string]: { [destinationChainId: string]: string } };
  } = {};

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
    return this.whitelistedRoutes[deposit.originChainId][deposit.originToken][deposit.destinationChainId];
  }

  getWhitelistedRoutes() {
    return this.whitelistedRoutes;
  }

  validateFillForDeposit(fill: Fill, deposit: Deposit) {
    // TODO: this method should validate the realizedLpFeePct and the destinationToken for the fill->deposit relationship.
    return true;
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.getBlockNumber())];
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.
    const [whitelistRouteEvents] = await Promise.all([
      await this.hubPool.queryFilter(this.hubPool.filters.WhitelistRoute()),
    ]);

    for (const event of whitelistRouteEvents) {
      const args = spreadEvent(event);
      if (args.enableRoute)
        assign(
          this.whitelistedRoutes, // Assign to the whitelistedRoutes object.
          [args.originChainId, args.originToken, args.destinationChainId], // Assign along this path.
          args.destinationToken // Assign this value.
        );
      else delete this.whitelistedRoutes[args.originChainId][args.originToken][args.destinationChainId];
    }
  }

  private async getBlockNumber(): Promise<number> {
    return await this.hubPool.provider.getBlockNumber();
  }
}
