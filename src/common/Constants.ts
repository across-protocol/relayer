import { utils } from "@across-protocol/sdk-v2";

// This version should increase each time the ConfigStore's config changes, otherwise relayer and dataworker logic
// will stop working to protect the user's funds.
export const CONFIG_STORE_VERSION = utils.CONFIG_STORE_VERSION;

// Do not change this value. Set 0 as the default version so that all timestamps before the first version update are
// deemed valid by ConfigStoreClient.hasValidConfigStoreVersionForTimestamp().
export const DEFAULT_CONFIG_STORE_VERSION = 0;

// Used for determining which block range corresponsd to which network. In order, the block ranges passed
// in the HubPool's proposeRootBundle method should be: Mainnet, Optimism, Polygon, Boba, Arbitrum
export const CHAIN_ID_LIST_INDICES = [1, 10, 137, 288, 42161];

export const RELAYER_MIN_FEE_PCT = 0.0003;

// Target ~4 hours
export const MAX_RELAYER_DEPOSIT_LOOK_BACK = 4 * 60 * 60;

// Target ~4 days per chain. Should cover all events needed to construct pending bundle.
export const DATAWORKER_FAST_LOOKBACK: { [chainId: number]: number } = {
  1: 28800,
  10: 1382400,
  137: 138240,
  288: 11520,
  42161: 1382400,
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
  1: 64, // Finalized block: https://www.alchemy.com/overviews/ethereum-commitment-levels
  10: 0,
  137: 128, // Commonly used finality level for CEX's that accept Polygon deposits
  288: 0,
  42161: 0,
};
export const MIN_DEPOSIT_CONFIRMATIONS: { [threshold: number | string]: { [chainId: number]: number } } = {
  1000: {
    1: 32, // Justified block
    10: 0,
    137: 100, // Probabilistically safe level based on historic Polygon reorgs
    288: 0,
    42161: 0,
  },
  100: {
    1: 16, // Mainnet reorgs are rarely > 4 blocks in depth so this is a very safe buffer
    10: 0,
    137: 80,
    288: 0,
    42161: 0,
  },
};
export const QUOTE_TIME_BUFFER = 12 * 5; // 5 blocks on Mainnet.

// Quicknode is the bottleneck here and imposes a 10k block limit on an event search.
// Alchemy-Polygon imposes a 3500 block limit.
// Note: a 0 value here leads to an infinite lookback, which would be useful and reduce RPC requests
// if the RPC provider allows it. This is why the user should override these lookbacks if they are not using
// Quicknode for example.
export const CHAIN_MAX_BLOCK_LOOKBACK = {
  1: 10000,
  10: 10000, // Quick
  137: 3490,
  288: 4990,
  42161: 10000,
};

export const BUNDLE_END_BLOCK_BUFFERS = {
  1: 100, // At 15s/block, 100 blocks = 20 mins
  10: 3000, // At a conservative 10 TPS, 300 seconds = 3000 transactions. And 1 block per txn.
  137: 1500, // At 1s/block, 25 mins seconds = 1500 blocks
  288: 50, // At 30s/block, 50 blocks = 25 mins
  42161: 3000, // At a conservative 10 TPS, 300 seconds = 3000 transactions. And 1 block per txn.
};

export const DEFAULT_RELAYER_GAS_MULTIPLIER = 1.2;

export const DEFAULT_MULTICALL_CHUNK_SIZE = 100;
export const CHAIN_MULTICALL_CHUNK_SIZE: { [chainId: number]: number } = {
  1: DEFAULT_MULTICALL_CHUNK_SIZE,
  10: 75,
  137: DEFAULT_MULTICALL_CHUNK_SIZE,
  288: DEFAULT_MULTICALL_CHUNK_SIZE,
  42161: DEFAULT_MULTICALL_CHUNK_SIZE,
};

// Maps chain ID to root bundle ID to ignore because the roots are known to be invalid from the perspective of the
// latest dataworker code, or there is no matching L1 root bundle, because the root bundle was relayed by an admin.
export const IGNORED_SPOKE_BUNDLES = {
  1: [357, 322, 321, 104, 101, 96, 89, 83, 79, 78, 75, 74, 23, 2],
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
export const IGNORED_HUB_PROPOSED_BUNDLES: number[] = [];
export const IGNORED_HUB_EXECUTED_BUNDLES: number[] = [];
