import { LZ_FEE_TOKENS } from "../common";
import { CHAIN_IDs } from "@across-protocol/constants";
import type { EdgeFamily, JussiRateLimitBucketDefinition, LogicalAsset, StableLogicalAsset } from "./types";

export const DEFAULT_HUB_POOL_CHAIN_ID = CHAIN_IDs.MAINNET;
export const JUSSI_LOGICAL_ASSETS: readonly LogicalAsset[] = ["USDC", "USDT", "WETH"];
export const EDGE_BUILD_BATCH_SIZE = Math.max(1, Number(process.env.JUSSI_EDGE_BUILD_BATCH_SIZE ?? "8") || 8);
export const STABLECOIN_PRICE_USD: Record<StableLogicalAsset, number> = { USDC: 1, USDT: 1 };
export const UNIVERSAL_INPUT_TIER_USD = "1000000000.000000";
export const EDGE_CLASS_INPUT_USD_SAMPLES = [1_000, 10_000, 100_000] as const;
export const EDGE_FIXED_COST_INPUT_USD_SAMPLE = Math.max(...EDGE_CLASS_INPUT_USD_SAMPLES);
export const EDGE_CLASS_RATE_SEGMENT_THRESHOLD_BPS = 5;
export const DEFAULT_ASSET_CLASSES: Record<string, LogicalAsset[]> = { ETH: ["WETH"], USD_STABLE: ["USDC", "USDT"] };
export const DEFAULT_CROSS_ASSET_VOLATILITY = "0.650000";
export const DEFAULT_CROSS_ASSET_VOLATILITY_SIGMA_MULTIPLIER = "2.000000";
export const DEFAULT_EXPECTED_FILL_LATENCY_SECONDS = 5;
export const DEFAULT_LATENCY_ANNUALIZED_COST_RATE = "0.05";
export const GAS_COST_AVERAGE_LOOKBACK_SECONDS = 24 * 60 * 60;
export const GAS_COST_AVERAGE_SAMPLE_WINDOWS = 12;
export const GAS_COST_AVERAGE_WINDOW_BLOCKS = 8;
export const GAS_COST_PRIORITY_FEE_PERCENTILE = 50;
export const GAS_COST_BLOCK_TIME_SAMPLE_BLOCKS = 1024;
export const MIN_GAS_COST_BLOCK_TIME_SECONDS = 0.1;
export const BINANCE_RATE_LIMIT_BUCKET_ID = "binance_withdrawals_24h_usd";
export const SLOW_WITHDRAWAL_LATENCY_SECONDS = 7 * 24 * 60 * 60;
export const LINEA_SCROLL_WITHDRAWAL_LATENCY_SECONDS = 4 * 60 * 60;
export const ZKSTACK_WITHDRAWAL_LATENCY_SECONDS = 60 * 60;
export const MONAD_EXECUTOR_LZ_RECEIVE_GAS_LIMIT = 120_000;
export const TOKEN_METADATA_OVERRIDES: Record<string, { decimals: number; priceUsd: number }> = {
  [`${CHAIN_IDs.TEMPO}:${LZ_FEE_TOKENS[CHAIN_IDs.TEMPO].toNative().toLowerCase()}`]: { decimals: 9, priceUsd: 1 },
};
export const GAS_UNITS_BY_FAMILY: Record<EdgeFamily, number> = {
  cctp: 250_000,
  oft: 320_000,
  canonical: 280_000,
  binance: 400_000,
  hyperliquid: 380_000,
  binance_cex_bridge: 240_000,
  bridgeapi: 180_000,
  hyperlane: 240_000,
};
export const LATENCY_BY_FAMILY: Record<EdgeFamily, number> = {
  cctp: 20 * 60,
  oft: 20 * 60,
  canonical: 20 * 60,
  binance: 5 * 60,
  hyperliquid: 5 * 60,
  binance_cex_bridge: 5 * 60,
  bridgeapi: 5 * 60,
  hyperlane: 20 * 60,
};
export const DEFAULT_PAIN_MODEL = {
  surplus_annualized_cost_rate: "0.000219",
  deficit_annualized_cost_rate: "0.002055",
  out_of_band_severity_multiplier: "4.0",
};
export const CUMULATIVE_BALANCE_BANDS: Record<
  LogicalAsset,
  { minBps: number; maxBps: number; outOfBandSeverityMultiplier: string }
> = {
  USDC: { minBps: 9_000, maxBps: 11_000, outOfBandSeverityMultiplier: "4.0" },
  USDT: { minBps: 9_000, maxBps: 11_000, outOfBandSeverityMultiplier: "4.0" },
  WETH: { minBps: 9_500, maxBps: 10_500, outOfBandSeverityMultiplier: "8.0" },
};
export const DEFAULT_RATE_LIMIT_BUCKETS: JussiRateLimitBucketDefinition[] = [
  {
    bucket_id: BINANCE_RATE_LIMIT_BUCKET_ID,
    capacity_usd: "21000000",
    window_seconds: 86_400,
    cost_usd: {
      segments: [
        { up_to_usage_usd: "12600000", marginal_cost_per_unit_usd: "0" },
        { up_to_usage_usd: "16800000", marginal_cost_per_unit_usd: "0.0005" },
        { up_to_usage_usd: "18900000", marginal_cost_per_unit_usd: "0.0025" },
        { up_to_usage_usd: "20370000", marginal_cost_per_unit_usd: "0.01" },
        { up_to_usage_usd: "21000000", marginal_cost_per_unit_usd: "0.05" },
      ],
    },
  },
];
