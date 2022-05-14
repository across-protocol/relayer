import { BigNumber, winston, toBNWei, toBN, assign } from "../../utils";
import { HubPoolClient, TokenClient } from "..";
import { InventorySettings } from "../../interfaces";

export class InventoryClient {
  constructor(
    readonly logger: winston.Logger,
    readonly inventorySettings: InventorySettings,
    readonly tokenClient: TokenClient,
    readonly hubPoolClient: HubPoolClient,
    readonly enabledChains: number[]
  ) {}

  getCumulativeBalance(token: string): BigNumber {
    return this.enabledChains
      .map((chainId) =>
        this.tokenClient.getBalance(chainId, this.hubPoolClient.getDestinationTokenForL1Token(token, chainId))
      )
      .reduce((acc, curr) => acc.add(curr), toBN(0));
  }

  async rebalanceInventoryIfNeeded() {
    console.log("REBALANCE", this.getCumulativeBalance("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48").toString());
  }
  async update() {}
}
