// Used for determining which block range corresponsd to which network. In order, the block ranges passed
// in the HubPool's proposeRootBundle method should be: Mainnet, Optimism, Polygon, Boba, Arbitrum
export const CHAIN_ID_LIST_INDICES = [1, 10, 137, 288, 42161];
// Optimism, ethereum can do infinity lookbacks. boba and Arbitrum limited to 100000 on infura.
export const CHAIN_MAX_BLOCK_LOOKBACK = {
  1: 0, // Note: 0 gets defaulted to infinity lookback
  10: 0,
  137: 3490,
  288: 4990,
  42161: 99990,
};
export const BUNDLE_END_BLOCK_BUFFERS = {
  1: 20, // At 15s/block, 20 blocks = 5 mins
  10: 150, // At a conservative 0.5 TPS, 300 seconds = 150 transactions. And 1 block per txn.
  137: 150, // At 2s/block, 300 seconds = 150 blocks
  288: 10, // At 30s/block, 10 blocks = 5 mins
  42161: 150, // At a conservative 0.5 TPS, 300 seconds = 150 transactions. And 1 block per txn.
};
