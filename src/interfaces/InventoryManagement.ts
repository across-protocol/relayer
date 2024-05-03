import { BigNumber, utils as ethersUtils } from "ethers";
import { TOKEN_SYMBOLS_MAP } from "../utils";

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
