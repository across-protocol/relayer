import { BigNumber } from "../utils";
// @notice Passed as input to HubPool.proposeRootBundle
export type BundleEvaluationBlockNumbers = number[];

export interface PoolRebalanceLeaf {
  chainId: BigNumber;
  groupIndex: BigNumber;
  bundleLpFees: BigNumber[];
  netSendAmounts: BigNumber[];
  runningBalances: BigNumber[];
  leafId: BigNumber;
  l1Tokens: string[];
}

export interface RelayerRefundLeaf {
  amountToReturn: BigNumber;
  chainId: BigNumber;
  refundAmounts: BigNumber[];
  leafId: BigNumber;
  l2TokenAddress: string;
  refundAddresses: string[];
}

export interface L1Token {
  address: string;
  symbol: string;
  decimals: number;
}
