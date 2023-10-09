import { BigNumber } from "ethers";

export interface InventoryConfig {
  tokenConfig: {
    [l1Token: string]: {
      [chainId: string]: {
        targetPct: BigNumber; // The desired amount of the given token on the L2 chainId.
        thresholdPct: BigNumber; // Threshold, below which, we will execute a rebalance.
        unwrapWethThreshold?: BigNumber; // Threshold for ETH on this chain to trigger WETH unwrapping to maintain ETH balance
        unwrapWethTarget?: BigNumber; // Amount of WETH to unwrap to refill ETH balance. Unused if unwrapWethThreshold
        // is undefined.
      };
    };
  };
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
