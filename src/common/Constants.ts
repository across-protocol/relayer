// Used for determining which block range corresponsd to which network. In order, the block ranges passed
// in the HubPool's proposeRootBundle method should be: Mainnet, Optimism, Polygon, Boba, Arbitrum
export const CHAIN_ID_LIST_INDICES = [1, 10, 137, 288, 42161];

// Target ~2 days per chain. Avg. block times: { 1: 15s, 10/42161: 0.5s, 137: 2.5s, 288: 30s }
export const MAX_RELAYER_DEPOSIT_LOOK_BACK: { [chainId: number]: number } = {
  1: 11500,
  10: 350000,
  137: 70000,
  288: 6000,
  42161: 350000,
};

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

export const DEFAULT_MULTICALL_CHUNK_SIZE = 100;
export const CHAIN_MULTICALL_CHUNK_SIZE: { [chainId: number]: number } = {
  1: DEFAULT_MULTICALL_CHUNK_SIZE,
  10: DEFAULT_MULTICALL_CHUNK_SIZE,
  137: DEFAULT_MULTICALL_CHUNK_SIZE,
  288: DEFAULT_MULTICALL_CHUNK_SIZE,
  42161: DEFAULT_MULTICALL_CHUNK_SIZE,
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
  "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828": {
    10: "0xE7798f023fC62146e8Aa1b36Da45fb70855a77Ea",
    137: "0x3066818837c5e6eD6601bd5a91B0762877A6B731",
    288: "0x780f33Ad21314d9A1Ffb6867Fe53d48a76Ec0D16",
    42161: "0xd693Ec944A85eeca4247eC1c3b130DCa9B0C3b22",
  }, // UMA
  "0x42bBFa2e77757C645eeaAd1655E0911a7553Efbc": {
    288: "0xa18bF3994C0Cc6E3b63ac420308E5383f53120D7",
  }, // BOBA
  "0x3472A5A71965499acd81997a54BBA8D852C6E53d": {
    137: "0x1FcbE5937B0cc2adf69772D228fA4205aCF4D9b2",
    42161: "0xBfa641051Ba0a0Ad1b0AcF549a89536A0D76472E",
  }, // BADGER
  "0xba100000625a3754423978a60c9317c58a424e3D": {
    10: "0xFE8B128bA8C78aabC59d4c64cEE7fF28e9379921",
    137: "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3",
    42161: "0x040d1EdC9569d4Bab2D15287Dc5A4F10F56a56B8",
  } // BAL
};

// Maps chain ID to root bundle ID to ignore because the roots are known to be invalid from the perspective of the
// latest dataworker code, or there is no matching L1 root bundle, because the root bundle was relayed by an admin.
export const IGNORED_SPOKE_BUNDLES = {
  1: [104, 101, 96, 89, 83, 79, 78, 75, 74, 23, 2],
  10: [105, 104, 101, 96, 89, 83, 79, 78, 75, 74, 23, 2],
  137: [105, 104, 101, 96, 89, 83, 79, 78, 75, 74, 23, 2],
  288: [96, 93, 90, 85, 78, 72, 68, 67, 65, 2],
  42161: [105, 104, 101, 96, 89, 83, 79, 78, 75, 74, 23, 2],
};

// List of proposal block numbers to ignore. This should be ignored because they are administrative bundle proposals
// with useless bundle block eval numbers and other data that isn't helpful for the dataworker to know. This does not
// include any invalid bundles that got through, such as at blocks 15001113 or 15049343 which are missing
// some events but have correct bundle eval blocks. This list specifically contains admin proposals that are sent
// to correct the bundles such as 15049343 that missed some events.
export const IGNORED_HUB_PROPOSED_BUNDLES = [];
export const IGNORED_HUB_EXECUTED_BUNDLES = [];
