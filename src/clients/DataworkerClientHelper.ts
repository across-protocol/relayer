// Used for determining which block range corresponsd to which network. In order, the block ranges passed
// in the HubPool's proposeRootBundle method should be: Mainnet, Optimism, Polygon, Boba, Arbitrum
export const CHAIN_ID_LIST_INDICES = [1, 10, 137, 288, 42161];
