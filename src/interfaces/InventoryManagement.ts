import { utils as ethersUtils } from "ethers";
import { BigNumber, TOKEN_SYMBOLS_MAP } from "../utils";

export type TokenBalanceConfig = {
  targetOverageBuffer: BigNumber; // Max multiplier for targetPct, to give flexibility in repayment chain selection.
  targetPct: BigNumber; // The desired amount of the given token on the L2 chainId.
  thresholdPct: BigNumber; // Threshold, below which, we will execute a rebalance.
  unwrapWethThreshold?: BigNumber; // Threshold for ETH to trigger WETH unwrapping to maintain ETH balance.
  unwrapWethTarget?: BigNumber; // Amount of WETH to unwrap to refill ETH. Unused if unwrapWethThreshold is undefined.
};

export type ChainTokenConfig = {
  [chainId: string]: TokenBalanceConfig;
};

// AliasConfig permits a single HubPool token to map onto multiple tokens on a remote chain.
export type ChainTokenInventory = {
  [symbol: string]: ChainTokenConfig;
};

/**
 * Example configuration:
 * - DAI on chains 10 & 42161.
 * - Bridged USDC (USDC.e, USDbC) on chains 10, 137, 324, 8453, 42161 & 59144.
 * - Native USDC on Polygon.
 *
 * All token allocations are "global", so Polygon will be allocated a total of 8% of all USDC:
 * - 4% of global USDC as Native USDC, and
 * - 4% as Bridged USDC.
 *
 * "tokenConfig": {
 *   "DAI": {
 *     "10": { "targetPct": 8, "thresholdPct": 4 },
 *     "42161": { "targetPct": 8, "thresholdPct": 4 },
 *   },
 *   "USDC": {
 *     "USDC.e": {
 *       "10": { "targetPct": 8, "thresholdPct": 4 },
 *       "137": { "targetPct": 4, "thresholdPct": 2 },
 *       "324": { "targetPct": 8, "thresholdPct": 4 },
 *       "42161": { "targetPct": 8, "thresholdPct": 4 },
 *       "59144": { "targetPct": 5, "thresholdPct": 2 }
 *     },
 *     "USDbC": {
 *       "8453": { "targetPct": 5, "thresholdPct": 2 }
 *     },
 *     "USDC": {
 *       "137": { "targetPct": 4, "thresholdPct": 2 }
 *     }
 *   }
 * }
 */
export interface InventoryConfig {
  // tokenConfig can map to a single token allocation, or a set of allocations that all map to the same HubPool token.
  tokenConfig: { [l1Token: string]: ChainTokenConfig } | { [l1Token: string]: ChainTokenInventory };

  // If ETH balance on chain is above threshold, wrap the excess over the target to WETH.
  wrapEtherTargetPerChain: {
    [chainId: number]: BigNumber;
  };
  wrapEtherTarget: BigNumber;
  wrapEtherThresholdPerChain: {
    [chainId: number]: BigNumber;
  };
  wrapEtherThreshold: BigNumber;
}

export function isAliasConfig(config: ChainTokenConfig | ChainTokenInventory): config is ChainTokenInventory {
  return (
    Object.keys(config).every((k) => ethersUtils.isAddress(k)) || Object.keys(config).every((k) => TOKEN_SYMBOLS_MAP[k])
  );
}
