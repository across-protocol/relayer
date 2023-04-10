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
  wrapEtherThreshold: BigNumber; // Number of Ether, that if the balance is above, wrap it to WETH on the L2. in wei
}
