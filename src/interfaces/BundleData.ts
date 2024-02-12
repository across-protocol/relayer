import { interfaces, typechain } from "@across-protocol/sdk-v2";
import { BigNumber } from "../utils";
export type ExpiredDepositsToRefundV3 = {
  [originChainId: number]: {
    [originToken: string]: interfaces.V3DepositWithBlock[];
  };
};

export type BundleDepositsV3 = {
  [originChainId: number]: {
    [originToken: string]: interfaces.V3DepositWithBlock[];
  };
};

export interface BundleFillV3 extends interfaces.V3FillWithBlock {
  lpFeePct: BigNumber;
}

// TODO: Consider not including `refunds`, `totalRefundAmount`, and `realizedLpFees` in the type as they can
// be computed pretty easily in O(n) time by the caller of loadData using this dictionary.
export type BundleFillsV3 = {
  [repaymentChainId: number]: {
    [repaymentToken: string]: {
      fills: BundleFillV3[];
      refunds: interfaces.Refund;
      totalRefundAmount: BigNumber;
      realizedLpFees: BigNumber;
    };
  };
};

export type BundleExcessSlowFills = {
  [destinationChainId: number]: {
    [destinationToken: string]: interfaces.V3DepositWithBlock[];
  };
};
export type BundleSlowFills = {
  [destinationChainId: number]: {
    [destinationToken: string]: interfaces.V3DepositWithBlock[];
  };
};

export type LoadDataReturnValue = {
  unfilledDeposits: interfaces.UnfilledDeposit[];
  fillsToRefund: interfaces.FillsToRefund;
  allValidFills: interfaces.FillWithBlock[];
  deposits: interfaces.DepositWithBlock[];
  earlyDeposits: typechain.FundsDepositedEvent[];
  bundleDepositsV3: BundleDepositsV3;
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3;
  bundleFillsV3: BundleFillsV3;
  unexecutableSlowFills: BundleExcessSlowFills;
  bundleSlowFillsV3: BundleSlowFills;
};
