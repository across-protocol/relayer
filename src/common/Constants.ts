import { CHAIN_IDs, TOKEN_SYMBOLS_MAP, ethers } from "../utils";

// Maximum supported version of the configuration loaded into the Across ConfigStore.
// It protects bots from running outdated code against newer version of the on-chain config store.
// @dev Incorrectly setting this value may lead to incorrect behaviour and potential loss of funds.
export const CONFIG_STORE_VERSION = 4;

export const RELAYER_MIN_FEE_PCT = 0.0003;

// Target ~4 hours
export const MAX_RELAYER_DEPOSIT_LOOK_BACK = 4 * 60 * 60;

// Target ~4 days per chain. Should cover all events needed to construct pending bundle.
export const DATAWORKER_FAST_LOOKBACK: { [chainId: number]: number } = {
  [CHAIN_IDs.MAINNET]: 28800,
  [CHAIN_IDs.OPTIMISM]: 172800, // 1 block every 2 seconds after bedrock
  [CHAIN_IDs.POLYGON]: 138240,
  [CHAIN_IDs.BOBA]: 11520,
  [CHAIN_IDs.ZK_SYNC]: 4 * 24 * 60 * 60,
  [CHAIN_IDs.LISK]: 172800, // Same as Optimism.
  [CHAIN_IDs.BASE]: 172800, // Same as Optimism.
  [CHAIN_IDs.MODE]: 172800, // Same as Optimism.
  [CHAIN_IDs.ARBITRUM]: 1382400,
  [CHAIN_IDs.LINEA]: 115200, // 1 block every 3 seconds
};

// Target ~14 days per chain. Should cover all events that could be finalized, so 2x the optimistic
// rollup challenge period seems safe.
export const FINALIZER_TOKENBRIDGE_LOOKBACK = 14 * 24 * 60 * 60;

// Reorgs are anticipated on Ethereum and Polygon. We use different following distances when processing deposit
// events based on the USD amount of the deposit. This protects the relayer from the worst case situation where it fills
// a large deposit (i.e. with an amount equal to a large amount of $$$) but the deposit is included in a re-orged
// block. This would cause the relayer to unintentionally send an invalid fill and not refunded. The tradeoff is that
// the larger the follow distance, the slower the relayer will be to fulfill deposits. Therefore, the following
// configuration allows the user to set higher follow distances for higher deposit amounts.
// The Key of the following dictionary is used as the USD threshold to determine the MDC:
// - Searching from highest USD threshold to lowest
// - If the key value is >= deposited USD amount, then use the MDC associated with the key for the origin chain
// - If no key values are >= depostied USD amount, use the "default" value for the origin chain
// - For example, a deposit on Polygon worth $90 would use the MDC associated with the 100 key and chain
// 137, so it would use a follow distance of 80 blocks, while a deposit on Polygon for $110 would use 1000
// key. A deposit of $1100 would use the "default" key

// To see the latest block reorg events go to:
// - Ethereum: https://etherscan.io/blocks_forked
// - Polygon: https://polygonscan.com/blocks_forked

// Optimistic Rollups are currently centrally serialized and are not expected to reorg. Technically a block on an
// ORU will not be finalized until after 7 days, so there is little difference in following behind 0 blocks versus
// anything under 7 days.
export const DEFAULT_MIN_DEPOSIT_CONFIRMATIONS = {
  [CHAIN_IDs.MAINNET]: 64, // Finalized block: https://www.alchemy.com/overviews/ethereum-commitment-levels
  [CHAIN_IDs.OPTIMISM]: 120,
  [CHAIN_IDs.POLYGON]: 128, // Commonly used finality level for CEX's that accept Polygon deposits
  [CHAIN_IDs.BOBA]: 0,
  [CHAIN_IDs.ZK_SYNC]: 120,
  [CHAIN_IDs.LISK]: 120, // Same as other OVM. Hard finality is 1800 blocks
  [CHAIN_IDs.BASE]: 120,
  [CHAIN_IDs.MODE]: 120,
  [CHAIN_IDs.ARBITRUM]: 0,
  [CHAIN_IDs.LINEA]: 30,
  // Testnets:
  [CHAIN_IDs.MODE_SEPOLIA]: 0,
  [CHAIN_IDs.POLYGON_AMOY]: 0,
  [CHAIN_IDs.BASE_SEPOLIA]: 0,
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: 0,
  [CHAIN_IDs.SEPOLIA]: 0,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: 0,
  [CHAIN_IDs.LISK_SEPOLIA]: 0,
};
export const MIN_DEPOSIT_CONFIRMATIONS: { [threshold: number | string]: { [chainId: number]: number } } = {
  1000: {
    [CHAIN_IDs.MAINNET]: 32, // Justified block
    [CHAIN_IDs.OPTIMISM]: 60,
    [CHAIN_IDs.POLYGON]: 100, // Probabilistically safe level based on historic Polygon reorgs
    [CHAIN_IDs.BOBA]: 0,
    [CHAIN_IDs.ZK_SYNC]: 0,
    [CHAIN_IDs.LISK]: 60,
    [CHAIN_IDs.BASE]: 60,
    [CHAIN_IDs.MODE]: 60,
    [CHAIN_IDs.ARBITRUM]: 0,
    [CHAIN_IDs.LINEA]: 1,
    // Testnets:
    [CHAIN_IDs.MODE_SEPOLIA]: 0,
    [CHAIN_IDs.LISK_SEPOLIA]: 0,
    [CHAIN_IDs.POLYGON_AMOY]: 0,
    [CHAIN_IDs.BASE_SEPOLIA]: 0,
    [CHAIN_IDs.OPTIMISM_SEPOLIA]: 0,
  },
  100: {
    [CHAIN_IDs.MAINNET]: 16, // Mainnet reorgs are rarely > 4 blocks in depth so this is a very safe buffer
    [CHAIN_IDs.OPTIMISM]: 60,
    [CHAIN_IDs.POLYGON]: 80,
    [CHAIN_IDs.BOBA]: 0,
    [CHAIN_IDs.ZK_SYNC]: 0,
    [CHAIN_IDs.LISK]: 60,
    [CHAIN_IDs.BASE]: 60,
    [CHAIN_IDs.MODE]: 60,
    [CHAIN_IDs.ARBITRUM]: 0,
    [CHAIN_IDs.LINEA]: 1,
    // Testnets:
    [CHAIN_IDs.MODE_SEPOLIA]: 0,
    [CHAIN_IDs.LISK_SEPOLIA]: 0,
    [CHAIN_IDs.POLYGON_AMOY]: 0,
    [CHAIN_IDs.BASE_SEPOLIA]: 0,
    [CHAIN_IDs.ARBITRUM_SEPOLIA]: 0,
  },
};

export const REDIS_URL_DEFAULT = "redis://localhost:6379";

// Quicknode is the bottleneck here and imposes a 10k block limit on an event search.
// Alchemy-Polygon imposes a 3500 block limit.
// Note: a 0 value here leads to an infinite lookback, which would be useful and reduce RPC requests
// if the RPC provider allows it. This is why the user should override these lookbacks if they are not using
// Quicknode for example.
export const CHAIN_MAX_BLOCK_LOOKBACK = {
  [CHAIN_IDs.MAINNET]: 10000,
  [CHAIN_IDs.OPTIMISM]: 10000, // Quick
  [CHAIN_IDs.POLYGON]: 3490,
  [CHAIN_IDs.BOBA]: 4990,
  [CHAIN_IDs.ZK_SYNC]: 10000,
  [CHAIN_IDs.LISK]: 1500,
  [CHAIN_IDs.BASE]: 1500,
  [CHAIN_IDs.MODE]: 1500,
  [CHAIN_IDs.ARBITRUM]: 10000,
  [CHAIN_IDs.LINEA]: 5000,
  // Testnets:
  [CHAIN_IDs.MODE_SEPOLIA]: 10000,
  [CHAIN_IDs.POLYGON_AMOY]: 10000,
  [CHAIN_IDs.LISK_SEPOLIA]: 10000,
  [CHAIN_IDs.BASE_SEPOLIA]: 10000,
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: 10000,
  [CHAIN_IDs.SEPOLIA]: 10000,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: 10000,
};

// These should be safely above the finalization period for the chain and
// also give enough buffer time so that any reasonable fill on the chain
// can be matched with a deposit on the origin chain, so something like
// ~1-2 mins per chain.
export const BUNDLE_END_BLOCK_BUFFERS = {
  [CHAIN_IDs.MAINNET]: 5, // 12s/block
  [CHAIN_IDs.OPTIMISM]: 60, // 2s/block
  [CHAIN_IDs.POLYGON]: 128, // 2s/block. Polygon reorgs often so this number is set larger than the largest observed reorg.
  [CHAIN_IDs.BOBA]: 0, // **UPDATE** 288 is disabled so there should be no buffer.
  [CHAIN_IDs.ZK_SYNC]: 120, // ~1s/block. ZkSync is a centralized sequencer but is relatively unstable so this is kept higher than 0
  [CHAIN_IDs.LISK]: 60, // 2s/block gives 2 mins buffer time.
  [CHAIN_IDs.BASE]: 60, // 2s/block. Same finality profile as Optimism
  [CHAIN_IDs.MODE]: 60, // 2s/block. Same finality profile as Optimism
  [CHAIN_IDs.ARBITRUM]: 240, // ~0.25s/block. Arbitrum is a centralized sequencer
  [CHAIN_IDs.LINEA]: 40, // At 3s/block, 2 mins = 40 blocks.
  // Testnets:
  [CHAIN_IDs.MODE_SEPOLIA]: 0,
  [CHAIN_IDs.LISK_SEPOLIA]: 0,
  [CHAIN_IDs.POLYGON_AMOY]: 0,
  [CHAIN_IDs.BASE_SEPOLIA]: 0,
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: 0,
  [CHAIN_IDs.SEPOLIA]: 0,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: 0,
};

export const DEFAULT_RELAYER_GAS_PADDING = ".15"; // Padding on token- and message-based relayer fill gas estimates.
export const DEFAULT_RELAYER_GAS_MULTIPLIER = "1.0"; // Multiplier on pre-profitability token-only gas estimates.
export const DEFAULT_RELAYER_GAS_MESSAGE_MULTIPLIER = "1.0"; // Multiplier on pre-profitability message fill gas estimates.

export const DEFAULT_MULTICALL_CHUNK_SIZE = 100;
export const DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE: { [chainId: number]: number } = {
  [CHAIN_IDs.OPTIMISM]: 75,
  [CHAIN_IDs.BASE]: 75,
  [CHAIN_IDs.LINEA]: 50,
};

// List of proposal block numbers to ignore. This should be ignored because they are administrative bundle proposals
// with useless bundle block eval numbers and other data that isn't helpful for the dataworker to know. This does not
// include any invalid bundles that got through, such as at blocks 15001113 or 15049343 which are missing
// some events but have correct bundle eval blocks. This list specifically contains admin proposals that are sent
// to correct the bundles such as 15049343 that missed some events.
export const IGNORED_HUB_PROPOSED_BUNDLES: number[] = [];
export const IGNORED_HUB_EXECUTED_BUNDLES: number[] = [];

// This is the max anticipated distance on each chain before RPC data is likely to be consistent amongst providers.
// This distance should consider re-orgs, but also the time needed for various RPC providers to agree on chain state.
// Provider caching will not be allowed for queries whose responses depend on blocks closer than this many blocks.
// This is intended to be conservative.
export const CHAIN_CACHE_FOLLOW_DISTANCE: { [chainId: number]: number } = {
  [CHAIN_IDs.MAINNET]: 128,
  [CHAIN_IDs.OPTIMISM]: 120,
  [CHAIN_IDs.POLYGON]: 256,
  [CHAIN_IDs.BOBA]: 0,
  [CHAIN_IDs.ZK_SYNC]: 512,
  [CHAIN_IDs.LISK]: 120,
  [CHAIN_IDs.BASE]: 120,
  [CHAIN_IDs.MODE]: 120,
  [CHAIN_IDs.ARBITRUM]: 32,
  [CHAIN_IDs.LINEA]: 100, // Linea has a soft-finality of 1 block. This value is padded - but at 3s/block the padding is 5 minutes
  [CHAIN_IDs.SCROLL]: 0,
  // Testnets:
  [CHAIN_IDs.MODE_SEPOLIA]: 0,
  [CHAIN_IDs.LISK_SEPOLIA]: 0,
  [CHAIN_IDs.POLYGON_AMOY]: 0,
  [CHAIN_IDs.BASE_SEPOLIA]: 0,
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: 0,
  [CHAIN_IDs.SEPOLIA]: 0,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: 0,
};

// This is the block distance at which the bot, by default, stores in redis with no TTL.
// These are all intended to be roughly 2 days of blocks for each chain.
// blocks = 172800 / avg_block_time
export const DEFAULT_NO_TTL_DISTANCE: { [chainId: number]: number } = {
  [CHAIN_IDs.MAINNET]: 14400,
  [CHAIN_IDs.OPTIMISM]: 86400,
  [CHAIN_IDs.POLYGON]: 86400,
  [CHAIN_IDs.BOBA]: 86400,
  [CHAIN_IDs.ZK_SYNC]: 172800,
  [CHAIN_IDs.LISK]: 86400,
  [CHAIN_IDs.BASE]: 86400,
  [CHAIN_IDs.MODE]: 86400,
  [CHAIN_IDs.LINEA]: 57600,
  [CHAIN_IDs.ARBITRUM]: 691200,
  [CHAIN_IDs.SCROLL]: 57600,
};

// Reasonable default maxFeePerGas and maxPriorityFeePerGas scalers for each chain.
export const DEFAULT_GAS_FEE_SCALERS: {
  [chainId: number]: { maxFeePerGasScaler: number; maxPriorityFeePerGasScaler: number };
} = {
  [CHAIN_IDs.MAINNET]: { maxFeePerGasScaler: 3, maxPriorityFeePerGasScaler: 1.2 },
  [CHAIN_IDs.OPTIMISM]: { maxFeePerGasScaler: 2, maxPriorityFeePerGasScaler: 1 },
  [CHAIN_IDs.LISK]: { maxFeePerGasScaler: 2, maxPriorityFeePerGasScaler: 1 },
  [CHAIN_IDs.BASE]: { maxFeePerGasScaler: 2, maxPriorityFeePerGasScaler: 1 },
  [CHAIN_IDs.MODE]: { maxFeePerGasScaler: 2, maxPriorityFeePerGasScaler: 1 },
};

// This is how many seconds stale the block number can be for us to use it for evaluating the reorg distance in the cache provider.
export const BLOCK_NUMBER_TTL = 60;

// This is the TTL for the provider cache.
export const PROVIDER_CACHE_TTL = 3600;
export const PROVIDER_CACHE_TTL_MODIFIER = 0.15;

// Multicall3 Constants:
export const multicall3Addresses = {
  [CHAIN_IDs.MAINNET]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.OPTIMISM]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.POLYGON]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.BOBA]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.ZK_SYNC]: "0xF9cda624FBC7e059355ce98a31693d299FACd963",
  [CHAIN_IDs.BASE]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.MODE]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.ARBITRUM]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.LINEA]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.SCROLL]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  // testnet
  [CHAIN_IDs.POLYGON_AMOY]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.BASE_SEPOLIA]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.SCROLL_SEPOLIA]: "0xcA11bde05977b3631167028862bE2a173976CA11",
  [CHAIN_IDs.SEPOLIA]: "0xcA11bde05977b3631167028862bE2a173976CA11",
};
export type Multicall2Call = {
  callData: ethers.utils.BytesLike;
  target: string;
};

// These are the spokes that can hold both ETH and WETH, so they should be added together when caclulating whether
// a bundle execution is possible with the funds in the pool.
export const spokesThatHoldEthAndWeth = [
  CHAIN_IDs.OPTIMISM,
  CHAIN_IDs.ZK_SYNC,
  CHAIN_IDs.LISK,
  CHAIN_IDs.BASE,
  CHAIN_IDs.MODE,
  CHAIN_IDs.LINEA,
];

/**
 * An official mapping of chain IDs to CCTP domains. This mapping is separate from chain identifiers
 * and is an internal mappinng maintained by Circle.
 * @link https://developers.circle.com/stablecoins/docs/supported-domains
 */
export const chainIdsToCctpDomains: { [chainId: number]: number } = {
  [CHAIN_IDs.MAINNET]: 0,
  [CHAIN_IDs.OPTIMISM]: 2,
  [CHAIN_IDs.ARBITRUM]: 3,
  [CHAIN_IDs.BASE]: 6,
  [CHAIN_IDs.POLYGON]: 7,
  [CHAIN_IDs.SEPOLIA]: 0,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: 2,
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: 3,
  [CHAIN_IDs.BASE_SEPOLIA]: 6,
  [CHAIN_IDs.POLYGON_AMOY]: 7,
};

export const SUPPORTED_TOKENS: { [chainId: number]: string[] } = {
  [CHAIN_IDs.OPTIMISM]: ["DAI", "SNX", "BAL", "WETH", "USDC", "POOL", "USDT", "WBTC", "UMA", "ACX"],
  [CHAIN_IDs.POLYGON]: ["USDC", "USDT", "WETH", "DAI", "WBTC", "UMA", "BAL", "ACX", "POOL"],
  [CHAIN_IDs.ZK_SYNC]: ["USDC", "USDT", "WETH", "WBTC", "DAI"],
  [CHAIN_IDs.LISK]: ["WETH", "USDT"],
  [CHAIN_IDs.BASE]: ["BAL", "DAI", "ETH", "WETH", "USDC", "POOL"],
  [CHAIN_IDs.MODE]: ["ETH", "WETH", "USDC", "USDT", "WBTC"],
  [CHAIN_IDs.ARBITRUM]: ["USDC", "USDT", "WETH", "DAI", "WBTC", "UMA", "BAL", "ACX", "POOL"],
  [CHAIN_IDs.LINEA]: ["USDC", "USDT", "WETH", "WBTC", "DAI"],

  // Testnets:
  [CHAIN_IDs.MODE_SEPOLIA]: ["ETH", "WETH", "USDC", "USDT", "WBTC"],
  [CHAIN_IDs.LISK_SEPOLIA]: ["WETH", "USDT"],
  [CHAIN_IDs.BASE_SEPOLIA]: ["BAL", "DAI", "ETH", "WETH", "USDC"],
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: ["USDC", "USDT", "WETH", "DAI", "WBTC", "UMA", "ACX"],
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: ["DAI", "SNX", "BAL", "ETH", "WETH", "USDC", "USDT", "WBTC", "UMA", "ACX"],
};

/**
 * A mapping of chain IDs to tokens on that chain which need their allowance
 * to first be zeroed before setting a new allowance. This is useful for
 * tokens that have a non-standard approval process.
 * @dev this is a generalization for USDT on Ethereum. Other tokens may be added
 */
export const TOKEN_APPROVALS_TO_FIRST_ZERO: Record<number, string[]> = {
  [CHAIN_IDs.MAINNET]: [
    // Required for USDT on Mainnet. Spurred by the following vulnerability:
    // https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
    // Essentially the current version of USDT has a vulnerability whose solution
    // requires the user to have a zero allowance prior to setting an approval.
    TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET],
  ],
};

// Path to the external SpokePool indexer. Must be updated if src/libexec/* files are relocated or if the `outputDir` on TSC has been modified.
export const RELAYER_DEFAULT_SPOKEPOOL_INDEXER = "./dist/src/libexec/RelayerSpokePoolIndexer.js";

export const DEFAULT_ARWEAVE_GATEWAY = { url: "arweave.net", port: 443, protocol: "https" };

// Chains with slow (> 2 day liveness) canonical L2-->L1 bridges that we prioritize taking repayment on.
// This does not include all  7-day withdrawal chains because we don't necessarily prefer being repaid on some of these 7-day chains, like Mode.
export const SLOW_WITHDRAWAL_CHAINS = [CHAIN_IDs.BASE, CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM];

// Expected worst-case time for message from L1 to propogate to L2 in seconds
export const EXPECTED_L1_TO_L2_MESSAGE_TIME = {
  [CHAIN_IDs.LINEA]: 60 * 60,
  [CHAIN_IDs.ARBITRUM]: 20 * 60,
  [CHAIN_IDs.OPTIMISM]: 20 * 60,
  [CHAIN_IDs.POLYGON]: 60 * 60,
  [CHAIN_IDs.ZK_SYNC]: 60 * 60,
  [CHAIN_IDs.LISK]: 20 * 60,
  [CHAIN_IDs.BASE]: 20 * 60,
  [CHAIN_IDs.MODE]: 20 * 60,
};
