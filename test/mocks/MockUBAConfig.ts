import { ubaFeeCalculator } from "@across-protocol/sdk-v2";
import { BigNumber, toBN, toBNWei } from "../utils";

export class MockUBAConfig extends ubaFeeCalculator.UBAFeeConfig {
  public readonly mockBalanceTriggerThreshold: Record<string, ubaFeeCalculator.ThresholdBoundType> = {};
  public mockBalanceTriggerThresholdDefault: ubaFeeCalculator.ThresholdBoundType;
  public readonly mockBalancingFeeTuple: Record<number, ubaFeeCalculator.FlowTupleParameters> = {};
  public mockBalancingFeeTupleDefault: ubaFeeCalculator.FlowTupleParameters;
  public readonly mockTargetBalance: Record<string, BigNumber> = {};
  public mockTargetBalanceDefault: BigNumber;

  constructor() {
    super(
      { default: toBN(0) },
      { default: [[toBNWei("0"), toBNWei("0")]] },
      {
        default: {
          lowerBound: { target: toBN(0), threshold: toBN(0) },
          upperBound: { target: toBN(0), threshold: toBN(0) },
        },
      },
      { default: [[toBN(0), toBN(0)]] },
      {},
      {}
    );
  }

  setBalanceTriggerThreshold(chainId: number, token: string, threshold: ubaFeeCalculator.ThresholdBoundType): void {
    const chainTokenCombination = `${chainId}-${token}`;
    this.mockBalanceTriggerThreshold[chainTokenCombination] = threshold;
    this.balanceTriggerThreshold[chainTokenCombination] = threshold;
  }

  setDefaultBalanceTriggerThreshold(threshold: ubaFeeCalculator.ThresholdBoundType): void {
    this.mockBalanceTriggerThresholdDefault = threshold;
    this.balanceTriggerThreshold.default = threshold;
  }

  setLpGammaFunctionTuples(chainId: number, flowCurve: ubaFeeCalculator.FlowTupleParameters): void {
    this.lpGammaFunction.override = {
      ...(this.lpGammaFunction.override ?? {}),
      [chainId]: flowCurve,
    };
  }

  setDefaultLpGammaFunctionTuples(flowCurve: ubaFeeCalculator.FlowTupleParameters): void {
    this.lpGammaFunction.default = flowCurve;
  }

  getBalanceTriggerThreshold(chainId: number, tokenSymbol: string): ubaFeeCalculator.ThresholdBoundType {
    const chainTokenCombination = `${chainId}-${tokenSymbol}`;
    return (
      this.mockBalanceTriggerThreshold[chainTokenCombination] ??
      this.mockBalanceTriggerThresholdDefault ??
      super.getBalanceTriggerThreshold(chainId, tokenSymbol)
    );
  }

  setBalancingFeeTuple(chainId: number, flowCurve: ubaFeeCalculator.FlowTupleParameters): void {
    this.mockBalancingFeeTuple[chainId] = flowCurve;
  }

  setDefaultBalancingFeeTuple(flowCurve: ubaFeeCalculator.FlowTupleParameters): void {
    this.mockBalancingFeeTupleDefault = flowCurve;
  }

  getBalancingFeeTuples(chainId: number): ubaFeeCalculator.FlowTupleParameters {
    return (
      this.mockBalancingFeeTuple[chainId] ?? this.mockBalancingFeeTupleDefault ?? super.getBalancingFeeTuples(chainId)
    );
  }

  setBaselineFee(originChainId: number, destinationChainId: number, fee: BigNumber, isDefault?: boolean): void {
    if (isDefault) {
      this.baselineFee.default = fee;
    } else {
      this.baselineFee.override = {
        ...(this.baselineFee.override ?? {}),
        [`${originChainId}-${destinationChainId}`]: fee,
      };
    }
    this.baselineFee[isDefault ? "default" : `${originChainId}-${destinationChainId}`] = fee;
  }

  setTargetBalance(chainId: number, tokenSymbol: string, target: BigNumber): void {
    this.mockTargetBalance[`${chainId}-${tokenSymbol}`] = target;
  }

  setDefaultTargetBalance(target: BigNumber): void {
    this.mockTargetBalanceDefault = target;
  }

  getTargetBalance(chainId: number, tokenSymbol: string): BigNumber {
    return (
      this.mockTargetBalance[`${chainId}-${tokenSymbol}`] ??
      this.mockTargetBalanceDefault ??
      super.getTargetBalance(chainId, tokenSymbol)
    );
  }
}
