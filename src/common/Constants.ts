import { utils } from "@across-protocol/sdk-v2";
import { ethers } from "../utils";

// This version should increase each time the ConfigStore's config changes, otherwise relayer and dataworker logic
// will stop working to protect the user's funds.
export const CONFIG_STORE_VERSION = utils.CONFIG_STORE_VERSION;

// Do not change this value. Set 0 as the default version so that all timestamps before the first version update are
// deemed valid by ConfigStoreClient.hasValidConfigStoreVersionForTimestamp().
export const DEFAULT_CONFIG_STORE_VERSION = 0;

// This list contains all chains that Across supports, although some of the chains could be currently disabled.
// The order of the chains is important to not change, as the dataworker proposes "bundle block numbers" per chain
// in the same order as the following list. To add a new chain ID, append it to the end of the list, never delete
// a chain ID. The on-chain ConfigStore should store a list of enabled/disabled chain ID's that are a subset
// of this list, so this list is simply the list of all possible Chain ID's that Across could support.
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

export const REDIS_URL_DEFAULT = "redis://localhost:6379";

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
  1: 25, // At 12s/block, 25 blocks = 5 mins
  10: 300, // At a conservative 1 TPS, 5 mins = 300 seconds = 300 transactions. And 1 block per txn.
  137: 750, // At 2s/block, 25 mins = 25 * 60 / 2 = 750 blocks
  288: 5, // At 60s/block, 50 blocks = 25 mins
  42161: 300, // At a conservative 1 TPS, 5 mins = 300 seconds = 300 transactions. And 1 block per txn.
};

export const DEFAULT_RELAYER_GAS_MULTIPLIER = 1.2;

export const DEFAULT_MULTICALL_CHUNK_SIZE = 100;
export const DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE: { [chainId: number]: number } = {
  10: 75,
};

// List of proposal block numbers to ignore. This should be ignored because they are administrative bundle proposals
// with useless bundle block eval numbers and other data that isn't helpful for the dataworker to know. This does not
// include any invalid bundles that got through, such as at blocks 15001113 or 15049343 which are missing
// some events but have correct bundle eval blocks. This list specifically contains admin proposals that are sent
// to correct the bundles such as 15049343 that missed some events.
export const IGNORED_HUB_PROPOSED_BUNDLES: number[] = [];
export const IGNORED_HUB_EXECUTED_BUNDLES: number[] = [];

// This is the max distance on each chain that reorgs can happen.
// Provider caching will not be allowed for queries whose responses depend on blocks closer than this many blocks.
// This is intended to be conservative.
export const MAX_REORG_DISTANCE: { [chainId: number]: number } = {
  1: 64,
  10: 0,
  137: 256,
  288: 0,
  42161: 0,
};

// This is how many seconds stale the block number can be for us to use it for evaluating the reorg distance in the cache provider.
export const BLOCK_NUMBER_TTL = 60;

// This is the TTL for the provider cache.
export const PROVIDER_CACHE_TTL = 3600;
export const PROVIDER_CACHE_TTL_MODIFIER = 0.15;

// Multicall3 Constants:
export const multicall3Addresses = {
  1: "0xcA11bde05977b3631167028862bE2a173976CA11",
  10: "0xcA11bde05977b3631167028862bE2a173976CA11",
  137: "0xcA11bde05977b3631167028862bE2a173976CA11",
  288: "0xcA11bde05977b3631167028862bE2a173976CA11",
  42161: "0xcA11bde05977b3631167028862bE2a173976CA11",
};
export type Multicall2Call = {
  callData: ethers.utils.BytesLike;
  target: string;
};
