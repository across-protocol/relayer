import { BigNumber } from "ethers";
import { UbaFlow } from "../../interfaces";

export { default as UBAFeeConfig } from "./UBAFeeConfig";
export { default as UBAFeeCalculator } from "./UBAFeeCalculator";
export { default as UBAFeeCalculatorWithRefresh } from "./UBAFeeCalculatorWithRefresh";
export * as UBAFeeUtility from "./UBAFeeUtility";

export type UBASpokeBalanceType = {
  chainId: number;
  blockNumber: number;
  lastValidatedRunningBalance?: BigNumber;
  recentRequestFlow: UbaFlow[];
  runningBalance?: BigNumber;
};
