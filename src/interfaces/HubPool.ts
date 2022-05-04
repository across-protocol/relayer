import { BigNumber } from "../utils";
import { SortableEvent } from "./Common";
// @notice Passed as input to HubPool.proposeRootBundle
export type BundleEvaluationBlockNumbers = number[];

export interface PoolRebalanceLeaf {
  chainId: number;
  groupIndex: number;
  bundleLpFees: BigNumber[];
  netSendAmounts: BigNumber[];
  runningBalances: BigNumber[];
  leafId: number;
  l1Tokens: string[];
}

export interface RelayerRefundLeaf {
  amountToReturn: BigNumber;
  chainId: number;
  refundAmounts: BigNumber[];
  leafId: number;
  l2TokenAddress: string;
  refundAddresses: string[];
}

export interface ProposedRootBundle extends SortableEvent {
  challengePeriodEndTimestamp: number;
  poolRebalanceLeafCount: number;
  bundleEvaluationBlockNumbers: BigNumber[];
  poolRebalanceRoot: string;
  relayerRefundRoot: string;
  slowRelayRoot: string;
  proposer: string;
}

export interface ExecutedRootBundle extends SortableEvent {
  chainId: number;
  bundleLpFees: BigNumber[];
  netSendAmounts: BigNumber[];
  runningBalances: BigNumber[];
  leafId: number;
  l1Tokens: string[];
  proof: string[];
}

export interface RelayerRefundLeafWithGroup extends RelayerRefundLeaf {
  groupIndex: number;
}

export interface L1Token {
  address: string;
  symbol: string;
  decimals: number;
}
