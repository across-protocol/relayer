import { interfaces } from "@across-protocol/sdk";
import { BigNumber } from "../utils";
export type ExpiredDepositsToRefundV3 = {
  [originChainId: number]: {
    [originToken: string]: interfaces.DepositWithBlock[];
  };
};

export type BundleDepositsV3 = {
  [originChainId: number]: {
    [originToken: string]: interfaces.DepositWithBlock[];
  };
};

export interface BundleFillV3 extends interfaces.FillWithBlock {
  lpFeePct: BigNumber;
}

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
    [destinationToken: string]: (interfaces.DepositWithBlock & { lpFeePct: BigNumber })[];
  };
};
export type BundleSlowFills = {
  [destinationChainId: number]: {
    [destinationToken: string]: (interfaces.DepositWithBlock & { lpFeePct: BigNumber })[];
  };
};

export type LoadDataReturnValue = {
  bundleDepositsV3: BundleDepositsV3;
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3;
  bundleFillsV3: BundleFillsV3;
  unexecutableSlowFills: BundleExcessSlowFills;
  bundleSlowFillsV3: BundleSlowFills;
};

export type BundleData = LoadDataReturnValue & {
  bundleBlockRanges: number[][];
};
