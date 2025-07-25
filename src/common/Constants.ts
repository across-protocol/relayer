import { DEFAULT_L2_CONTRACT_ADDRESSES } from "@eth-optimism/sdk";
import {
  chainIsOPStack,
  chainIsOrbit,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  Signer,
  Provider,
  ZERO_ADDRESS,
  bnUint32Max,
  EvmAddress,
  toWei,
  BigNumber,
} from "../utils";
import {
  BaseBridgeAdapter,
  OpStackDefaultERC20Bridge,
  SnxOptimismBridge,
  DaiOptimismBridge,
  UsdcTokenSplitterBridge,
  OpStackWethBridge,
  PolygonWethBridge,
  PolygonERC20Bridge,
  ArbitrumOrbitBridge,
  LineaBridge,
  LineaWethBridge,
  BlastBridge,
  ScrollERC20Bridge,
  OpStackUSDCBridge,
  UsdcCCTPBridge,
  ZKStackBridge,
  ZKStackUSDCBridge,
  ZKStackWethBridge,
  OFTBridge,
  BinanceCEXBridge,
  BinanceCEXNativeBridge,
  SolanaUsdcCCTPBridge,
} from "../adapter/bridges";
import {
  BaseL2BridgeAdapter,
  OpStackUSDCBridge as L2OpStackUSDCBridge,
  OpStackWethBridge as L2OpStackWethBridge,
  ArbitrumOrbitBridge as L2ArbitrumOrbitBridge,
  OpStackBridge as L2OpStackBridge,
  BinanceCEXBridge as L2BinanceCEXBridge,
  UsdcCCTPBridge as L2UsdcCCTPBridge,
} from "../adapter/l2Bridges";
import { CONTRACT_ADDRESSES } from "./ContractAddresses";
import { HyperlaneXERC20Bridge } from "../adapter/bridges/HyperlaneXERC20Bridge";
import { HyperlaneXERC20BridgeL2 } from "../adapter/l2Bridges/HyperlaneXERC20Bridge";

/**
 * Note: When adding new chains, it's preferred to retain alphabetical ordering of CHAIN_IDs in Object mappings.
 */

// Maximum supported version of the configuration loaded into the Across ConfigStore.
// It protects bots from running outdated code against newer version of the on-chain config store.
// @dev Incorrectly setting this value may lead to incorrect behaviour and potential loss of funds.
export const CONFIG_STORE_VERSION = 6;

export const RELAYER_MIN_FEE_PCT = 0.0001;

// max(uint256) - 1
export const INFINITE_FILL_DEADLINE = bnUint32Max;

// Target ~4 hours
export const MAX_RELAYER_DEPOSIT_LOOK_BACK = 4 * 60 * 60;

// Target ~14 days per chain. Should cover all events that could be finalized, so 2x the optimistic
// rollup challenge period seems safe.
export const FINALIZER_TOKENBRIDGE_LOOKBACK = 14 * 24 * 60 * 60;

// Reorgs are anticipated on Ethereum and Polygon. We use different following distances when processing deposit
// events based on the USD amount of the deposit. This protects the relayer from the worst case situation where it fills
// a large deposit (i.e. with an amount equal to a large amount of $$$) but the deposit is included in a re-orged
// block. This would cause the relayer to unintentionally send an invalid fill and not refunded. The tradeoff is that
// the larger the follow distance, the slower the relayer will be to fulfill deposits. Therefore, the following
// configuration allows the user to set higher follow distances for higher deposit amounts.
// The key of the following dictionary is used as the USD threshold to determine the MDC:
// - Searching from highest USD threshold to lowest
// - If the key is >= deposited USD amount, then use the MDC associated with the key for the origin chain
// - If no keys are >= deposited USD amount, ignore the deposit.
// To see the latest block reorg events go to:
// - Ethereum: https://etherscan.io/blocks_forked
// - Polygon: https://polygonscan.com/blocks_forked
// Optimistic Rollups are currently centrally serialized and are not expected to reorg. Technically a block on an
// ORU will not be finalized until after 7 days, so there is little difference in following behind 0 blocks versus
// anything under 7 days. OP stack chains are auto-populated based on chain family.
const OP_STACK_MIN_DEPOSIT_CONFIRMATIONS = 1;
const ORBIT_MIN_DEPOSIT_CONFIRMATIONS = 1;
const MDC_DEFAULT_THRESHOLD = 1000;

export const MIN_DEPOSIT_CONFIRMATIONS: { [threshold: number | string]: { [chainId: number]: number } } = {
  10000: {
    [CHAIN_IDs.MAINNET]: 32,
    [CHAIN_IDs.POLYGON]: 128, // Commonly used finality level for CEX's that accept Polygon deposits
    [CHAIN_IDs.BSC]: 3, // Average takes 2.5 blocks to finalize but reorgs rarely happen
    [CHAIN_IDs.SCROLL]: 18,
  },
  [MDC_DEFAULT_THRESHOLD]: {
    [CHAIN_IDs.MAINNET]: 4,
    [CHAIN_IDs.POLYGON]: 64, // Probabilistically safe level based on historic Polygon reorgs
    [CHAIN_IDs.BSC]: 2, // Average takes 2.5 blocks to finalize but reorgs rarely happen
    [CHAIN_IDs.SCROLL]: 8,
  },
  100: {
    [CHAIN_IDs.LENS]: 0,
    [CHAIN_IDs.LINEA]: 1,
    [CHAIN_IDs.MAINNET]: 2, // Mainnet reorgs are rarely > 1 - 2 blocks in depth.
    [CHAIN_IDs.POLYGON]: 16,
    [CHAIN_IDs.SCROLL]: 2,
    [CHAIN_IDs.BSC]: 0,
    [CHAIN_IDs.ZK_SYNC]: 0,
  },
};

// Auto-populate all known OP stack chains. These are only applied as defaults; explicit config above is respected.
MIN_DEPOSIT_CONFIRMATIONS[MDC_DEFAULT_THRESHOLD] ??= {};
Object.values(CHAIN_IDs)
  .filter((chainId) => chainIsOPStack(chainId) || chainIsOrbit(chainId) || chainId === CHAIN_IDs.ARBITRUM)
  .forEach((chainId) => {
    if (chainIsOPStack(chainId)) {
      MIN_DEPOSIT_CONFIRMATIONS[MDC_DEFAULT_THRESHOLD][chainId] ??= OP_STACK_MIN_DEPOSIT_CONFIRMATIONS;
    } else if (chainIsOrbit(chainId) || chainId === CHAIN_IDs.ARBITRUM) {
      MIN_DEPOSIT_CONFIRMATIONS[MDC_DEFAULT_THRESHOLD][chainId] ??= ORBIT_MIN_DEPOSIT_CONFIRMATIONS;
    }
  });

export const REDIS_URL_DEFAULT = "redis://localhost:6379";

// Quicknode is the bottleneck here and imposes a 10k block limit on an event search.
// Alchemy-Polygon imposes a 3500 block limit.
// Note: a 0 value here leads to an infinite lookback, which would be useful and reduce RPC requests
// if the RPC provider allows it. This is why the user should override these lookbacks if they are not using
// Quicknode for example.
export const CHAIN_MAX_BLOCK_LOOKBACK = {
  [CHAIN_IDs.ALEPH_ZERO]: 10000,
  [CHAIN_IDs.ARBITRUM]: 10000,
  [CHAIN_IDs.BASE]: 10000,
  [CHAIN_IDs.BLAST]: 10000,
  [CHAIN_IDs.BOBA]: 4990,
  [CHAIN_IDs.BSC]: 10000,
  [CHAIN_IDs.UNICHAIN]: 10000,
  [CHAIN_IDs.INK]: 10000,
  [CHAIN_IDs.LENS]: 10000,
  [CHAIN_IDs.LINEA]: 5000,
  [CHAIN_IDs.LISK]: 10000,
  [CHAIN_IDs.MAINNET]: 10000,
  [CHAIN_IDs.MODE]: 10000,
  [CHAIN_IDs.OPTIMISM]: 10000, // Quick
  [CHAIN_IDs.POLYGON]: 10000,
  [CHAIN_IDs.REDSTONE]: 10000,
  [CHAIN_IDs.SCROLL]: 10000,
  [CHAIN_IDs.SONEIUM]: 10000,
  [CHAIN_IDs.SOLANA]: 1000,
  [CHAIN_IDs.WORLD_CHAIN]: 10000,
  [CHAIN_IDs.ZK_SYNC]: 10000,
  [CHAIN_IDs.ZORA]: 10000,
  // Testnets:
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: 10000,
  [CHAIN_IDs.BASE_SEPOLIA]: 10000,
  [CHAIN_IDs.BLAST_SEPOLIA]: 10000,
  [CHAIN_IDs.INK_SEPOLIA]: 10000,
  [CHAIN_IDs.LENS_SEPOLIA]: 10000,
  [CHAIN_IDs.LISK_SEPOLIA]: 10000,
  [CHAIN_IDs.MODE_SEPOLIA]: 10000,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: 10000,
  [CHAIN_IDs.POLYGON_AMOY]: 10000,
  [CHAIN_IDs.TATARA]: 10000,
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: 10000,
  [CHAIN_IDs.SEPOLIA]: 10000,
};

// These should be safely above the finalization period for the chain and
// also give enough buffer time so that any reasonable fill on the chain
// can be matched with a deposit on the origin chain, so something like
// ~1-2 mins per chain.
export const BUNDLE_END_BLOCK_BUFFERS = {
  [CHAIN_IDs.ALEPH_ZERO]: 240, // Same as Arbitrum
  [CHAIN_IDs.ARBITRUM]: 240, // ~0.25s/block. Arbitrum is a centralized sequencer
  [CHAIN_IDs.BASE]: 60, // 2s/block. Same finality profile as Optimism
  [CHAIN_IDs.BLAST]: 60,
  [CHAIN_IDs.BOBA]: 0, // **UPDATE** 288 is disabled so there should be no buffer.
  [CHAIN_IDs.BSC]: 5, // 2x the average 2.5 finality block time https://www.bnbchain.org/en/blog/the-coming-fastfinality-on-bsc
  [CHAIN_IDs.UNICHAIN]: 120, // 1s/block gives 2 mins buffer time
  [CHAIN_IDs.LENS]: 120, // ~1s/block. Uses same sequencing logic as ZkSync.
  [CHAIN_IDs.LINEA]: 40, // At 3s/block, 2 mins = 40 blocks.
  [CHAIN_IDs.LISK]: 60, // 2s/block gives 2 mins buffer time.
  [CHAIN_IDs.INK]: 120, // 1s/block gives 2 mins buffer time
  [CHAIN_IDs.MAINNET]: 5, // 12s/block
  [CHAIN_IDs.MODE]: 60, // 2s/block. Same finality profile as Optimism
  [CHAIN_IDs.OPTIMISM]: 60, // 2s/block
  [CHAIN_IDs.POLYGON]: 128, // 2s/block. Polygon reorgs often so this number is set larger than the largest observed reorg.
  [CHAIN_IDs.REDSTONE]: 60, // 2s/block
  [CHAIN_IDs.SCROLL]: 40, // ~3s/block
  [CHAIN_IDs.SOLANA]: 150, // ~400ms/block
  [CHAIN_IDs.SONEIUM]: 60, // 2s/block
  [CHAIN_IDs.WORLD_CHAIN]: 60, // 2s/block
  [CHAIN_IDs.ZK_SYNC]: 120, // ~1s/block. ZkSync is a centralized sequencer but is relatively unstable so this is kept higher than 0
  [CHAIN_IDs.ZORA]: 60, // 2s/block
  // Testnets:
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: 0,
  [CHAIN_IDs.BASE_SEPOLIA]: 0,
  [CHAIN_IDs.BLAST_SEPOLIA]: 0,
  [CHAIN_IDs.INK_SEPOLIA]: 0,
  [CHAIN_IDs.LENS_SEPOLIA]: 0,
  [CHAIN_IDs.LISK_SEPOLIA]: 0,
  [CHAIN_IDs.MODE_SEPOLIA]: 0,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: 0,
  [CHAIN_IDs.POLYGON_AMOY]: 0,
  [CHAIN_IDs.TATARA]: 0,
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: 0,
  [CHAIN_IDs.SEPOLIA]: 0,
};

export const DEFAULT_RELAYER_GAS_PADDING = ".15"; // Padding on token- and message-based relayer fill gas estimates.
export const DEFAULT_RELAYER_GAS_MULTIPLIER = "1.0"; // Multiplier on pre-profitability token-only gas estimates.
export const DEFAULT_RELAYER_GAS_MESSAGE_MULTIPLIER = "1.0"; // Multiplier on pre-profitability message fill gas estimates.

export const DEFAULT_MULTICALL_CHUNK_SIZE = 50;

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
  [CHAIN_IDs.ALEPH_ZERO]: 60,
  [CHAIN_IDs.ARBITRUM]: 32,
  [CHAIN_IDs.BASE]: 120,
  [CHAIN_IDs.BLAST]: 120,
  [CHAIN_IDs.BOBA]: 0,
  [CHAIN_IDs.BSC]: 5, // FastFinality on BSC makes finality time probabilistic but it takes an average of 2.5 blocks.
  [CHAIN_IDs.UNICHAIN]: 120,
  [CHAIN_IDs.INK]: 120, // Follows Optimism
  [CHAIN_IDs.LENS]: 512,
  [CHAIN_IDs.LISK]: 120,
  [CHAIN_IDs.LINEA]: 100, // Linea has a soft-finality of 1 block. This value is padded - but at 3s/block the padding is 5 minutes
  [CHAIN_IDs.MAINNET]: 128,
  [CHAIN_IDs.MODE]: 120,
  [CHAIN_IDs.OPTIMISM]: 120,
  [CHAIN_IDs.POLYGON]: 256,
  [CHAIN_IDs.REDSTONE]: 120,
  [CHAIN_IDs.SCROLL]: 100,
  [CHAIN_IDs.SOLANA]: 512,
  [CHAIN_IDs.SONEIUM]: 120,
  [CHAIN_IDs.WORLD_CHAIN]: 120,
  [CHAIN_IDs.ZK_SYNC]: 512,
  [CHAIN_IDs.ZORA]: 120,
  // Testnets:
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: 0,
  [CHAIN_IDs.BASE_SEPOLIA]: 0,
  [CHAIN_IDs.BLAST_SEPOLIA]: 0,
  [CHAIN_IDs.INK_SEPOLIA]: 0,
  [CHAIN_IDs.LISK_SEPOLIA]: 0,
  [CHAIN_IDs.LENS_SEPOLIA]: 0,
  [CHAIN_IDs.MODE_SEPOLIA]: 0,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: 0,
  [CHAIN_IDs.POLYGON_AMOY]: 0,
  [CHAIN_IDs.TATARA]: 0,
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: 0,
  [CHAIN_IDs.SEPOLIA]: 0,
};

// This is the block distance at which the bot, by default, stores in redis with no TTL.
// These are all intended to be roughly 2 days of blocks for each chain.
// blocks = 172800 / avg_block_time
export const DEFAULT_NO_TTL_DISTANCE: { [chainId: number]: number } = {
  [CHAIN_IDs.ALEPH_ZERO]: 691200,
  [CHAIN_IDs.ARBITRUM]: 691200,
  [CHAIN_IDs.BASE]: 86400,
  [CHAIN_IDs.BLAST]: 86400,
  [CHAIN_IDs.BOBA]: 86400,
  [CHAIN_IDs.UNICHAIN]: 86400,
  [CHAIN_IDs.INK]: 86400,
  [CHAIN_IDs.LENS]: 172800,
  [CHAIN_IDs.LINEA]: 57600,
  [CHAIN_IDs.LISK]: 86400,
  [CHAIN_IDs.MAINNET]: 14400,
  [CHAIN_IDs.MODE]: 86400,
  [CHAIN_IDs.OPTIMISM]: 86400,
  [CHAIN_IDs.POLYGON]: 86400,
  [CHAIN_IDs.REDSTONE]: 86400,
  [CHAIN_IDs.SCROLL]: 57600,
  [CHAIN_IDs.SOLANA]: 432000,
  [CHAIN_IDs.SONEIUM]: 86400,
  [CHAIN_IDs.WORLD_CHAIN]: 86400,
  [CHAIN_IDs.ZK_SYNC]: 172800,
  [CHAIN_IDs.ZORA]: 86400,
};

// Reasonable default maxFeePerGas and maxPriorityFeePerGas scalers for each chain.
export const DEFAULT_GAS_FEE_SCALERS: {
  [chainId: number]: { maxFeePerGasScaler: number; maxPriorityFeePerGasScaler: number };
} = {
  [CHAIN_IDs.MAINNET]: { maxFeePerGasScaler: 3, maxPriorityFeePerGasScaler: 1.2 },
};

// Auto-populate OP stack defaults.
Object.values(CHAIN_IDs)
  .filter(chainIsOPStack)
  .forEach((chainId) => {
    DEFAULT_GAS_FEE_SCALERS[chainId] = { maxFeePerGasScaler: 1.1, maxPriorityFeePerGasScaler: 1.1 };
  });

// This is how many seconds stale the block number can be for us to use it for evaluating the reorg distance in the cache provider.
export const BLOCK_NUMBER_TTL = 60;

// This is the TTL for the provider cache.
export const PROVIDER_CACHE_TTL = 3600;
export const PROVIDER_CACHE_TTL_MODIFIER = 0.15;

// These are the spokes that can hold the native token for that network, so they should be added together when calculating whether
// a bundle execution is possible with the funds in the pool.
export const spokesThatHoldNativeTokens = [
  CHAIN_IDs.BASE,
  CHAIN_IDs.BLAST,
  CHAIN_IDs.UNICHAIN,
  CHAIN_IDs.INK,
  CHAIN_IDs.LENS,
  CHAIN_IDs.LINEA,
  CHAIN_IDs.LISK,
  CHAIN_IDs.MODE,
  CHAIN_IDs.OPTIMISM,
  CHAIN_IDs.REDSTONE,
  CHAIN_IDs.SCROLL,
  CHAIN_IDs.SONEIUM,
  CHAIN_IDs.WORLD_CHAIN,
  CHAIN_IDs.ZK_SYNC,
  CHAIN_IDs.ZORA,
];

// A mapping of L2 chain IDs to an array of tokens Across supports on that chain.
export const SUPPORTED_TOKENS: { [chainId: number]: string[] } = {
  [CHAIN_IDs.ALEPH_ZERO]: ["USDT", "WETH"],
  [CHAIN_IDs.ARBITRUM]: ["USDC", "USDT", "WETH", "DAI", "WBTC", "UMA", "BAL", "ACX", "POOL", "ezETH"],
  [CHAIN_IDs.BASE]: ["BAL", "DAI", "ETH", "WETH", "USDC", "USDT", "POOL", "VLR", "ezETH"],
  [CHAIN_IDs.BLAST]: ["DAI", "WBTC", "WETH", "ezETH"],
  [CHAIN_IDs.BSC]: ["CAKE", "WBNB", "USDC", "USDT", "WETH"],
  [CHAIN_IDs.UNICHAIN]: ["ETH", "WETH", "USDC", "ezETH"],
  [CHAIN_IDs.INK]: ["ETH", "WETH"],
  [CHAIN_IDs.LENS]: ["WETH", "WGHO", "USDC"],
  [CHAIN_IDs.LINEA]: ["USDC", "USDT", "WETH", "WBTC", "DAI", "ezETH"],
  [CHAIN_IDs.LISK]: ["WETH", "USDC", "USDT", "LSK", "WBTC"],
  [CHAIN_IDs.MODE]: ["ETH", "WETH", "USDC", "USDT", "WBTC", "ezETH"],
  [CHAIN_IDs.OPTIMISM]: [
    "DAI",
    "SNX",
    "BAL",
    "WETH",
    "USDC",
    "POOL",
    "USDT",
    "WBTC",
    "WLD",
    "UMA",
    "ACX",
    "VLR",
    "ezETH",
  ],
  [CHAIN_IDs.POLYGON]: ["USDC", "USDT", "WETH", "DAI", "WBTC", "UMA", "BAL", "ACX", "POOL"],
  [CHAIN_IDs.REDSTONE]: ["WETH"],
  [CHAIN_IDs.SCROLL]: ["WETH", "USDC", "USDT", "WBTC", "POOL"],
  [CHAIN_IDs.SOLANA]: ["USDC"],
  [CHAIN_IDs.SONEIUM]: ["WETH", "USDC"],
  [CHAIN_IDs.WORLD_CHAIN]: ["WETH", "WBTC", "USDC", "WLD", "POOL"],
  [CHAIN_IDs.ZK_SYNC]: ["USDC", "USDT", "WETH", "WBTC", "DAI"],
  [CHAIN_IDs.ZORA]: ["USDC", "WETH"],

  // Testnets:
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: ["USDC", "WETH"],
  [CHAIN_IDs.BASE_SEPOLIA]: ["WETH", "USDC"],
  [CHAIN_IDs.BLAST_SEPOLIA]: ["WETH"],
  [CHAIN_IDs.POLYGON_AMOY]: ["WETH", "USDC"],
  [CHAIN_IDs.LENS_SEPOLIA]: ["WETH", "GRASS"],
  [CHAIN_IDs.LISK_SEPOLIA]: ["WETH"],
  [CHAIN_IDs.TATARA]: ["TATARA-USDC", "WETH"],
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: ["WETH", "USDC"],
  [CHAIN_IDs.MODE_SEPOLIA]: ["WETH"],
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: ["WETH", "USDC"],
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

// Type alias for a function which takes in arbitrary arguments and outputs a BaseBridgeAdapter class.
type L1BridgeConstructor<T extends BaseBridgeAdapter> = new (...args: any[]) => T;

// Map of chain IDs to all "canonical bridges" for the given chain. Canonical is loosely defined -- in this
// case, it is the default bridge for the given chain.
export const CANONICAL_BRIDGE: Record<number, L1BridgeConstructor<BaseBridgeAdapter>> = {
  [CHAIN_IDs.ALEPH_ZERO]: ArbitrumOrbitBridge,
  [CHAIN_IDs.ARBITRUM]: ArbitrumOrbitBridge,
  [CHAIN_IDs.BASE]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.BLAST]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.BSC]: BinanceCEXBridge,
  [CHAIN_IDs.UNICHAIN]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.INK]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.LENS]: ZKStackBridge,
  [CHAIN_IDs.LINEA]: LineaBridge,
  [CHAIN_IDs.LISK]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.MODE]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.OPTIMISM]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.POLYGON]: PolygonERC20Bridge,
  [CHAIN_IDs.REDSTONE]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.SCROLL]: ScrollERC20Bridge,
  [CHAIN_IDs.SOLANA]: SolanaUsdcCCTPBridge,
  [CHAIN_IDs.SONEIUM]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.WORLD_CHAIN]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.ZK_SYNC]: ZKStackBridge,
  [CHAIN_IDs.ZORA]: OpStackDefaultERC20Bridge,
  // Testnets:
  [CHAIN_IDs.LENS_SEPOLIA]: ZKStackBridge,
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: ArbitrumOrbitBridge,
  [CHAIN_IDs.BASE_SEPOLIA]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.BLAST_SEPOLIA]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.LISK_SEPOLIA]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.MODE_SEPOLIA]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: OpStackDefaultERC20Bridge,
  [CHAIN_IDs.POLYGON_AMOY]: PolygonERC20Bridge,
  [CHAIN_IDs.SCROLL_SEPOLIA]: ScrollERC20Bridge,
  [CHAIN_IDs.TATARA]: PolygonERC20Bridge, // No rebalacing is supported.
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: OpStackDefaultERC20Bridge,
};

export const CANONICAL_L2_BRIDGE: {
  [chainId: number]: {
    new (
      l2chainId: number,
      hubChainId: number,
      l2Signer: Signer,
      l1Provider: Provider | Signer,
      l1Token?: EvmAddress
    ): BaseL2BridgeAdapter;
  };
} = {
  [CHAIN_IDs.ALEPH_ZERO]: L2ArbitrumOrbitBridge,
  [CHAIN_IDs.BSC]: L2BinanceCEXBridge,
  [CHAIN_IDs.LISK]: L2OpStackBridge,
  [CHAIN_IDs.REDSTONE]: L2OpStackBridge,
  [CHAIN_IDs.ZORA]: L2OpStackBridge,
};

// Custom Bridges are all bridges between chains which only support a small number (typically one) of tokens.
// In addition to mapping a chain to the custom bridges, we also need to specify which token the bridge supports.
export const CUSTOM_BRIDGE: Record<number, Record<string, L1BridgeConstructor<BaseBridgeAdapter>>> = {
  [CHAIN_IDs.ARBITRUM]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: UsdcTokenSplitterBridge,
    [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: OFTBridge,
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20Bridge,
  },
  [CHAIN_IDs.BASE]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: UsdcTokenSplitterBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20Bridge,
  },
  [CHAIN_IDs.BLAST]: {
    [TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET]]: BlastBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20Bridge,
  },
  [CHAIN_IDs.BSC]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: BinanceCEXNativeBridge,
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20Bridge,
  },
  [CHAIN_IDs.UNICHAIN]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: UsdcCCTPBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20Bridge,
  },
  [CHAIN_IDs.INK]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
  },
  [CHAIN_IDs.LENS]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: ZKStackWethBridge,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: ZKStackUSDCBridge,
  },
  [CHAIN_IDs.LINEA]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: UsdcCCTPBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: LineaWethBridge,
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20Bridge,
  },
  [CHAIN_IDs.LISK]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: OpStackUSDCBridge,
  },
  [CHAIN_IDs.MODE]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20Bridge,
  },
  [CHAIN_IDs.OPTIMISM]: {
    [TOKEN_SYMBOLS_MAP.SNX.addresses[CHAIN_IDs.MAINNET]]: SnxOptimismBridge,
    [TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET]]: DaiOptimismBridge,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: UsdcTokenSplitterBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20Bridge,
  },
  [CHAIN_IDs.POLYGON]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: PolygonWethBridge,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: UsdcTokenSplitterBridge,
  },
  [CHAIN_IDs.REDSTONE]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
  },
  [CHAIN_IDs.SONEIUM]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: OpStackUSDCBridge,
  },
  [CHAIN_IDs.WORLD_CHAIN]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: UsdcCCTPBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20Bridge,
  },
  [CHAIN_IDs.ZK_SYNC]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: ZKStackWethBridge,
  },
  [CHAIN_IDs.ZORA]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: OpStackWethBridge,
  },

  // Testnet
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.SEPOLIA]]: UsdcTokenSplitterBridge,
  },
  [CHAIN_IDs.BASE_SEPOLIA]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.SEPOLIA]]: UsdcTokenSplitterBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.SEPOLIA]]: OpStackWethBridge,
  },
  [CHAIN_IDs.BLAST_SEPOLIA]: {
    [TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.SEPOLIA]]: BlastBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.SEPOLIA]]: OpStackWethBridge,
  },
  [CHAIN_IDs.LISK_SEPOLIA]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.SEPOLIA]]: OpStackWethBridge,
  },
  [CHAIN_IDs.MODE_SEPOLIA]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.SEPOLIA]]: OpStackWethBridge,
  },
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.SEPOLIA]]: UsdcTokenSplitterBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.SEPOLIA]]: OpStackWethBridge,
  },
  [CHAIN_IDs.POLYGON_AMOY]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.SEPOLIA]]: PolygonWethBridge,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.SEPOLIA]]: UsdcCCTPBridge, // Only support CCTP USDC.
  },
  [CHAIN_IDs.LENS_SEPOLIA]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.SEPOLIA]]: ZKStackWethBridge,
  },
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.SEPOLIA]]: OpStackWethBridge,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.SEPOLIA]]: UsdcCCTPBridge,
  },
};

export const CUSTOM_L2_BRIDGE: {
  [chainId: number]: {
    [tokenAddress: string]: {
      new (
        l2chainId: number,
        hubChainId: number,
        l2Signer: Signer,
        l1Provider: Provider | Signer,
        l1Token?: EvmAddress
      ): BaseL2BridgeAdapter;
    };
  };
} = {
  [CHAIN_IDs.LISK]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: L2OpStackUSDCBridge,
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: L2OpStackWethBridge,
  },
  [CHAIN_IDs.REDSTONE]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: L2OpStackWethBridge,
  },
  [CHAIN_IDs.ZORA]: {
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: L2OpStackWethBridge,
  },
  [CHAIN_IDs.OPTIMISM]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20BridgeL2,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: L2UsdcCCTPBridge,
  },
  [CHAIN_IDs.ARBITRUM]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20BridgeL2,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: L2UsdcCCTPBridge,
  },
  [CHAIN_IDs.MODE]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20BridgeL2,
  },
  [CHAIN_IDs.LINEA]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20BridgeL2,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: L2UsdcCCTPBridge,
  },
  [CHAIN_IDs.BLAST]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20BridgeL2,
  },
  [CHAIN_IDs.BASE]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20BridgeL2,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: L2UsdcCCTPBridge,
  },
  [CHAIN_IDs.UNICHAIN]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20BridgeL2,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: L2UsdcCCTPBridge,
  },
  [CHAIN_IDs.POLYGON]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: L2UsdcCCTPBridge,
  },
  [CHAIN_IDs.BSC]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20BridgeL2,
  },
  [CHAIN_IDs.WORLD_CHAIN]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: HyperlaneXERC20BridgeL2,
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: L2UsdcCCTPBridge,
  },
};

// Path to the external SpokePool indexer. Must be updated if src/libexec/* files are relocated or if the `outputDir` on TSC has been modified.
export const RELAYER_SPOKEPOOL_LISTENER_EVM = "./dist/src/libexec/RelayerSpokePoolListener.js";
export const RELAYER_SPOKEPOOL_LISTENER_SVM = "./dist/src/libexec/RelayerSpokePoolListenerSVM.js";

export const DEFAULT_ARWEAVE_GATEWAY = { url: "arweave.net", port: 443, protocol: "https" };

export const ARWEAVE_TAG_BYTE_LIMIT = 2048;

// Chains with slow (> 2 day liveness) canonical L2-->L1 bridges that we prioritize taking repayment on.
// This does not include all 7-day withdrawal chains because we don't necessarily prefer being repaid on some of these 7-day chains, like Mode.
// This list should generally exclude Lite chains because the relayer ignores HubPool liquidity in that case which could cause the
// relayer to unintentionally overdraw the HubPool's available reserves.
export const SLOW_WITHDRAWAL_CHAINS = [CHAIN_IDs.ARBITRUM, CHAIN_IDs.BASE, CHAIN_IDs.OPTIMISM, CHAIN_IDs.BLAST];

// Arbitrum Orbit chains may have custom gateways for certain tokens. These gateways need to be specified since token approvals are directed at the
// gateway, while function calls are directed at the gateway router.
export const CUSTOM_ARBITRUM_GATEWAYS: { [chainId: number]: { [address: string]: { l1: string; l2: string } } } = {
  [CHAIN_IDs.ARBITRUM]: {
    [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: {
      l1: "0xcEe284F754E854890e311e3280b767F80797180d", // USDT
      l2: "0x096760F208390250649E3e8763348E783AEF5562",
    },
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: {
      l1: "0xcEe284F754E854890e311e3280b767F80797180d", // USDC
      l2: "0x096760F208390250649E3e8763348E783AEF5562", // If we want to bridge to USDC.e, we need to specify a unique Arbitrum Gateway.
    },
    [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: {
      l1: "0xd92023E9d9911199a6711321D1277285e6d4e2db", // WETH
      l2: "0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B",
    },
    [TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET]]: {
      l1: "0xD3B5b60020504bc3489D6949d545893982BA3011", // DAI
      l2: "0x467194771dAe2967Aef3ECbEDD3Bf9a310C76C65",
    },
  },
};

// The default ERC20 gateway is the generic gateway used by Arbitrum Orbit chains to mint tokens which do not have a custom gateway set.
export const DEFAULT_ARBITRUM_GATEWAY: { [chainId: number]: { l1: string; l2: string } } = {
  [CHAIN_IDs.ALEPH_ZERO]: {
    l1: "0xccaF21F002EAF230c9Fa810B34837a3739B70F7B",
    l2: "0x2A5a79061b723BBF453ef7E07c583C750AFb9BD6",
  },
  [CHAIN_IDs.ARBITRUM]: {
    l1: "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC",
    l2: "0x09e9222E96E7B4AE2a407B98d48e330053351EEe",
  },
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: {
    l1: "0x902b3E5f8F19571859F4AB1003B960a5dF693aFF",
    l2: "0x6e244cD02BBB8a6dbd7F626f05B2ef82151Ab502",
  },
};

// We currently support WBTC, USDT, USDC, and WETH as routes on scroll. WBTC, USDT, and USDC transfer events can all be queried from the standard ERC20
// gateway, WETH has its own custom gateways, and other ERC20s may also have their own gateway, so it is very important to define unique gateways (ones
// which are NOT the standard ERC20 gateway) if/when we add new deposit routes.
export const SCROLL_CUSTOM_GATEWAY: { [chainId: number]: { l1: string; l2: string } } = {
  [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: {
    l1: "0x7AC440cAe8EB6328de4fA621163a792c1EA9D4fE",
    l2: "0x7003E7B7186f0E6601203b99F7B8DECBfA391cf9",
  },
  [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: {
    l1: "0xf1AF3b23DE0A5Ca3CAb7261cb0061C0D779A5c7B",
    l2: "0x33B60d5Dd260d453cAC3782b0bDC01ce84672142",
  },
};

// Expected worst-case time for message from L1 to propagate to L2 in seconds
export const EXPECTED_L1_TO_L2_MESSAGE_TIME = {
  [CHAIN_IDs.ALEPH_ZERO]: 20 * 60,
  [CHAIN_IDs.ARBITRUM]: 20 * 60,
  [CHAIN_IDs.BASE]: 20 * 60,
  [CHAIN_IDs.BLAST]: 20 * 60,
  [CHAIN_IDs.UNICHAIN]: 20 * 60,
  [CHAIN_IDs.INK]: 20 * 60,
  [CHAIN_IDs.LENS]: 60 * 60,
  [CHAIN_IDs.LINEA]: 60 * 60,
  [CHAIN_IDs.LISK]: 20 * 60,
  [CHAIN_IDs.MODE]: 20 * 60,
  [CHAIN_IDs.OPTIMISM]: 20 * 60,
  [CHAIN_IDs.POLYGON]: 60 * 60,
  [CHAIN_IDs.REDSTONE]: 20 * 60,
  [CHAIN_IDs.SCROLL]: 60 * 60,
  [CHAIN_IDs.SOLANA]: 60 * 30,
  [CHAIN_IDs.SONEIUM]: 20 * 60,
  [CHAIN_IDs.WORLD_CHAIN]: 20 * 60,
  [CHAIN_IDs.ZK_SYNC]: 60 * 60,
  [CHAIN_IDs.ZORA]: 20 * 60,
};

export const OPSTACK_CONTRACT_OVERRIDES = {
  [CHAIN_IDs.BASE]: {
    // https://github.com/ethereum-optimism/ecosystem/blob/8df6ab1afcf49312dc7e89ed079f910843d74427/packages/sdk/src/utils/chain-constants.ts#L252
    l1: {
      DisputeGameFactory: "0x43edB88C4B80fDD2AdFF2412A7BebF9dF42cB40e",
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.BLAST]: {
    l1: {
      AddressManager: "0xE064B565Cf2A312a3e66Fe4118890583727380C0",
      L1CrossDomainMessenger: "0x5D4472f31Bd9385709ec61305AFc749F0fA8e9d0",
      L1StandardBridge: CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET].ovmStandardBridge_81457.address,
      StateCommitmentChain: ZERO_ADDRESS,
      CanonicalTransactionChain: ZERO_ADDRESS,
      BondManager: ZERO_ADDRESS,
      OptimismPortal: CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET].blastOptimismPortal.address,
      L2OutputOracle: "0x826D1B0D4111Ad9146Eb8941D7Ca2B6a44215c76",
      OptimismPortal2: ZERO_ADDRESS,
      DisputeGameFactory: ZERO_ADDRESS,
    },
    // https://github.com/blast-io/blast/blob/master/blast-optimism/op-bindings/predeploys/addresses.go
    l2: {
      ...DEFAULT_L2_CONTRACT_ADDRESSES,
      WETH: TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.BLAST],
    },
  },
  [CHAIN_IDs.LISK]: {
    l1: {
      DisputeGameFactory: "0x0CF7D3706a27CCE2017aEB11E8a9c8b5388c282C",
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.MODE]: {
    l1: {
      DisputeGameFactory: "0x6f13EFadABD9269D6cEAd22b448d434A1f1B433E",
    },
  },
  [CHAIN_IDs.REDSTONE]: {
    l1: {
      AddressManager: "0xFe27f187A9E46104a932189dDF229871E06B22F8",
      L1CrossDomainMessenger: "0x592C1299e0F8331D81A28C0FC7352Da24eDB444a",
      L1StandardBridge: CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET].ovmStandardBridge_690.address,
      StateCommitmentChain: ZERO_ADDRESS,
      CanonicalTransactionChain: ZERO_ADDRESS,
      BondManager: ZERO_ADDRESS,
      OptimismPortal: "0xC7bCb0e8839a28A1cFadd1CF716de9016CdA51ae",
      L2OutputOracle: "0xa426A052f657AEEefc298b3B5c35a470e4739d69",
      OptimismPortal2: ZERO_ADDRESS,
      DisputeGameFactory: ZERO_ADDRESS,
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.SONEIUM]: {
    l1: {
      DisputeGameFactory: "0x512a3d2c7a43bd9261d2b8e8c9c70d4bd4d503c0",
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.WORLD_CHAIN]: {
    l1: {
      DisputeGameFactory: "0x069c4c579671f8c120b1327a73217D01Ea2EC5ea",
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.INK]: {
    l1: {
      DisputeGameFactory: "0x10d7b35078d3baabb96dd45a9143b94be65b12cd",
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.UNICHAIN]: {
    l1: {
      DisputeGameFactory: "0x2F12d621a16e2d3285929C9996f478508951dFe4",
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.ZORA]: {
    l1: {
      DisputeGameFactory: "0xB0F15106fa1e473Ddb39790f197275BC979Aa37e",
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },

  // Testnets
  [CHAIN_IDs.BASE_SEPOLIA]: {
    l1: {
      DisputeGameFactory: "0xd6E6dBf4F7EA0ac412fD8b65ED297e64BB7a06E1",
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.LISK_SEPOLIA]: {
    l1: {
      AddressManager: "0x27Bb4A7cd8FB20cb816BF4Aac668BF841bb3D5d3",
      L1CrossDomainMessenger: "0x857824E6234f7733ecA4e9A76804fd1afa1A3A2C",
      L1StandardBridge: CONTRACT_ADDRESSES[CHAIN_IDs.SEPOLIA].ovmStandardBridge_4202.address,
      StateCommitmentChain: ZERO_ADDRESS,
      CanonicalTransactionChain: ZERO_ADDRESS,
      BondManager: ZERO_ADDRESS,
      OptimismPortal: "0xe3d90F21490686Ec7eF37BE788E02dfC12787264",
      L2OutputOracle: "0xA0E35F56C318DE1bD5D9ca6A94Fe7e37C5663348",
      OptimismPortal2: ZERO_ADDRESS,
      DisputeGameFactory: ZERO_ADDRESS,
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.BLAST_SEPOLIA]: {
    l1: {
      AddressManager: "0x092dD3E2272a372cdfbcCb8F689423F09ED6242a",
      L1CrossDomainMessenger: "0x9338F298F29D3918D5D1Feb209aeB9915CC96333",
      L1StandardBridge: CONTRACT_ADDRESSES[CHAIN_IDs.SEPOLIA].ovmStandardBridge_168587773.address,
      StateCommitmentChain: ZERO_ADDRESS,
      CanonicalTransactionChain: ZERO_ADDRESS,
      BondManager: ZERO_ADDRESS,
      OptimismPortal: "0x2757E4430e694F27b73EC9C02257cab3a498C8C5",
      L2OutputOracle: "0x311fF72DfE214ADF97618DD2E731637E8F41bD8c",
      OptimismPortal2: ZERO_ADDRESS,
      DisputeGameFactory: ZERO_ADDRESS,
    },
    l2: {
      ...DEFAULT_L2_CONTRACT_ADDRESSES,
      WETH: TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.BLAST_SEPOLIA],
    },
  },
  [CHAIN_IDs.MODE_SEPOLIA]: {
    l1: {
      AddressManager: "0x83D45725d6562d8CD717673D6bb4c67C07dC1905",
      L1CrossDomainMessenger: "0xc19a60d9E8C27B9A43527c3283B4dd8eDC8bE15C",
      L1StandardBridge: CONTRACT_ADDRESSES[CHAIN_IDs.SEPOLIA].ovmStandardBridge_919.address,
      StateCommitmentChain: ZERO_ADDRESS,
      CanonicalTransactionChain: ZERO_ADDRESS,
      BondManager: ZERO_ADDRESS,
      OptimismPortal: "0x320e1580effF37E008F1C92700d1eBa47c1B23fD",
      L2OutputOracle: "0x2634BD65ba27AB63811c74A63118ACb312701Bfa",
      OptimismPortal2: ZERO_ADDRESS,
      DisputeGameFactory: ZERO_ADDRESS,
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: {
    l1: {
      DisputeGameFactory: "0xeff73e5aa3B9AEC32c659Aa3E00444d20a84394b",
    },
    l2: DEFAULT_L2_CONTRACT_ADDRESSES,
  },
};

export const DEFAULT_GAS_MULTIPLIER: { [chainId: number]: number } = {
  [CHAIN_IDs.OPTIMISM]: 1.5,
  [CHAIN_IDs.BASE]: 1.5,
  [CHAIN_IDs.BSC]: 1.5,
  [CHAIN_IDs.UNICHAIN]: 1.5,
  [CHAIN_IDs.INK]: 1.5,
  [CHAIN_IDs.LISK]: 1.5,
  [CHAIN_IDs.MODE]: 1.5,
  [CHAIN_IDs.REDSTONE]: 1.5,
  [CHAIN_IDs.SONEIUM]: 1.5,
  [CHAIN_IDs.WORLD_CHAIN]: 1.5,
  [CHAIN_IDs.ZORA]: 1.5,
};

export const CONSERVATIVE_BUNDLE_FREQUENCY_SECONDS = 3 * 60 * 60; // 3 hours is a safe assumption for the time

export const ARBITRUM_ORBIT_L1L2_MESSAGE_FEE_DATA: {
  [chainId: number]: {
    // Amount of tokens required to send a single message to the L2
    amountWei: number;
    // Multiple of the required amount above to send to the feePayer in case
    // we are short funds. For example, if set to 10, then everytime we need to load more funds
    // we'll send 10x the required amount.
    amountMultipleToFund: number;
    // Account that pays the fees on-chain that we will load more fee tokens into.
    feePayer?: string;
    // Token that the feePayer will pay the fees in.
    feeToken?: string;
  };
} = {
  // Leave feePayer undefined if feePayer is HubPool.
  // Leave feeToken undefined if feeToken is ETH.
  [CHAIN_IDs.ARBITRUM]: {
    amountWei: 0.02,
    amountMultipleToFund: 1,
  },
  [CHAIN_IDs.ALEPH_ZERO]: {
    amountWei: 0.49,
    amountMultipleToFund: 50,
    feePayer: "0x0d57392895Db5aF3280e9223323e20F3951E81B1", // DonationBox
    feeToken: TOKEN_SYMBOLS_MAP.AZERO.addresses[CHAIN_IDs.MAINNET],
  },
};

// source: https://github.com/hyperlane-xyz/hyperlane-registry/blob/346b18c4314cf96b41ae2da781f58fb832dbe1f8/deployments/warp_routes/EZETH/arbitrum-base-berachain-blast-bsc-ethereum-fraxtal-linea-mode-optimism-sei-swell-taiko-unichain-worldchain-zircuit-config.yaml
export const HYPERLANE_ROUTERS: { [chainId: number]: { [tokenAddress: string]: string } } = {
  [CHAIN_IDs.MAINNET]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET]]: "0xC59336D8edDa9722B4f1Ec104007191Ec16f7087",
  },
  [CHAIN_IDs.ARBITRUM]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.ARBITRUM]]: "0xB26bBfC6d1F469C821Ea25099017862e7368F4E8",
  },
  [CHAIN_IDs.BASE]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.BASE]]: "0x2552516453368e42705D791F674b312b8b87CD9e",
  },
  [CHAIN_IDs.BLAST]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.BLAST]]: "0x486b39378f99f073A3043C6Aabe8666876A8F3C5",
  },
  [CHAIN_IDs.MODE]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MODE]]: "0xC59336D8edDa9722B4f1Ec104007191Ec16f7087",
  },
  [CHAIN_IDs.LINEA]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.LINEA]]: "0xC59336D8edDa9722B4f1Ec104007191Ec16f7087",
  },
  [CHAIN_IDs.UNICHAIN]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.UNICHAIN]]: "0xFf0247f72b0d7ceD319D8457dD30622a2bed78B5",
  },
  [CHAIN_IDs.OPTIMISM]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.OPTIMISM]]: "0xacEB607CdF59EB8022Cc0699eEF3eCF246d149e2",
  },
  [CHAIN_IDs.BSC]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.BSC]]: "0xE00C6185a5c19219F1FFeD213b4406a254968c26",
  },
  [CHAIN_IDs.WORLD_CHAIN]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.WORLD_CHAIN]]: "0x530b6596af6B6aB4D355d7Af2b5FF12eAeef8261",
  },
};

// 0.1 ETH is a default cap for chains that use ETH as their gas token
export const HYPERLANE_DEFAULT_FEE_CAP = toWei("0.1");
export const HYPERLANE_FEE_CAP_OVERRIDES: { [chainId: number]: BigNumber } = {
  // all supported chains that have non-eth for gas token should go here.
  // 0.4 BNB fee cap on BSC
  [CHAIN_IDs.BSC]: toWei("0.4"),
};
