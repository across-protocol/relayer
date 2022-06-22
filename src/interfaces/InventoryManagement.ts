import { BigNumber } from "../utils";

export interface InventoryConfig {
  tokenConfig: {
    [l1Token: string]: {
      [chainId: string]: {
        targetPct: BigNumber; // The desired amount of the given token on the L2 chainId.
        thresholdPct: BigNumber; // Threshold, below which, we will execute a rebalance.
        partialFillThresholdPct?: BigNumber; // Will partially fill deposits when relayer balance on this chain is below this % of total allocation
        partialFillAmountPct?: BigNumber; // For partial fills, use this % of relayer balance for the current chain to submit partial fill.
      };
    };
  };
  wrapEtherThreshold: BigNumber; // Number of Ether, that if the balance is above, wrap it to WETH on the L2. in wei
}
