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
  1: 100, // At 15s/block, 100 blocks = 20 mins
  10: 3000, // At a conservative 10 TPS, 300 seconds = 3000 transactions. And 1 block per txn.
  137: 1500, // At 1s/block, 25 mins seconds = 1500 blocks
  288: 50, // At 30s/block, 50 blocks = 25 mins
  42161: 3000, // At a conservative 10 TPS, 300 seconds = 3000 transactions. And 1 block per txn.
};
