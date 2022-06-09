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


// The most critical failure mode that can happen in the inventory management module is a miss-mapping between L1 token
//  and the associated L2 token. If this is wrong the bot WILL delete money. The mapping below is used to enforce that 
// what the hubpool thinks is the correct L2 token for a given L1 token is actually the correct L2 token. It is simply a
//  sanity check: if for whatever reason this does not line up the bot show fail loudly and stop execution as something 
// is broken and funds are not safe to be sent over the canonical L2 bridges.
export const l2TokensToL1TokenValidation = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": {
    10: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    137: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    288: "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc",
    42161: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
  }, // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": {
    10: "0x4200000000000000000000000000000000000006",
    137: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    288: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  }, // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": {
    10: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    137: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    288: "0xf74195Bb8a5cf652411867c5C2C5b8C2a402be35",
    42161: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  }, // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": {
    10: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    137: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    288: "0xdc0486f8bf31DF57a952bcd3c1d3e166e3d9eC8b",
    42161: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  }, // WBTC
};