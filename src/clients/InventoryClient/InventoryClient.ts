import { BigNumber, winston, toBNWei, toBN, assign } from "../../utils";
import { HubPoolClient, TokenClient } from "..";
import { InventorySettings } from "../../interfaces";

export class InventoryClient {
  constructor(
    readonly logger: winston.Logger,
    readonly inventorySettings: InventorySettings,
    readonly tokenClient: TokenClient,
    readonly hubClient: HubPoolClient,
    readonly enabledChains: number[]
  ) {}

  getCumulativeBalance(token: string): BigNumber {
    return this.enabledChains
      .map((chainId) => this.tokenClient.getBalance(chainId, token))
      .reduce((acc, curr) => acc.add(curr), toBN(0));
  }

  async rebalanceInventoryIfNeeded() {
    console.log("REBALANCE", this.getCumulativeBalance(""));
  }
  async update() {}
}
