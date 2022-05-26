export interface InventoryConfig {
  managedL1Tokens: string[]; // Define which L1 tokens should have their inventory managed.
  targetL2PctOfTotal: { [chainId: string]: number }; // The % of the total capital that we target to have on each chainId.
  rebalanceOvershoot: number; // When rebalancing how much extra should be sent to prevent high frequency sends.
}
