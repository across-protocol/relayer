// Used for determining which block range corresponsd to which network. In order, the block ranges passed
// in the HubPool's proposeRootBundle method should be: Mainnet, Optimism, Polygon, Boba, Arbitrum
export const CHAIN_ID_LIST_INDICES = [1, 10, 137, 288, 42161];
// Optimism, ethereum can do infinity lookbacks. boba and Aribtrum limited to 100000 on infura.
export const CHAIN_MAX_BLOCK_LOOKBACK = {
  1: 0, // Note: 0 gets defaulted to infinity lookback
  10: 0,
  137: 99990,
  288: 99990,
  42161: 99990,
};

export const EMPTY_MERKLE_ROOT = "0x0000000000000000000000000000000000000000000000000000000000000000";
