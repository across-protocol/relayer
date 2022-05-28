import { BigNumber } from "../utils";

export interface InventoryConfig {
  managedL1Tokens: string[]; // Define which L1 tokens should have their inventory managed.
  targetL2PctOfTotal: { [chainId: string]: BigNumber }; // The % of the total capital that we target to have on each chainId.
  rebalanceOvershoot: BigNumber; // When rebalancing what % extra should be sent to prevent high frequency sends.
  wrapEtherThreshold: BigNumber; // Number of Ether, that if the balance is above, wrap it to WETH on the L2. in wei
}
