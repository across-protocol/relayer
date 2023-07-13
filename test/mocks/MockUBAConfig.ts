import { ubaFeeCalculator } from "@across-protocol/sdk-v2";
import { toBN, toBNWei } from "../utils";

export class MockUBAConfig extends ubaFeeCalculator.UBAFeeConfig {
  public readonly mockBalanceTriggerThreshold: Record<string, ubaFeeCalculator.ThresholdBoundType> = {};
  public readonly mockBalancingFeeTuple: Record<number, ubaFeeCalculator.FlowTupleParameters> = {};

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
  }

  getBalanceTriggerThreshold(chainId: number, tokenSymbol: string): ubaFeeCalculator.ThresholdBoundType {
    const chainTokenCombination = `${chainId}-${tokenSymbol}`;
    return (
      this.mockBalanceTriggerThreshold[chainTokenCombination] ?? super.getBalanceTriggerThreshold(chainId, tokenSymbol)
    );
  }

  setBalancingFeeTuple(chainId: number, flowCurve: FlowTupleParameters): void {
    this.mockBalancingFeeTuple[chainId] = flowCurve;
  }

  getBalancingFeeTuples(chainId: number): FlowTupleParameters {
    return this.mockBalancingFeeTuple[chainId] ?? super.getBalancingFeeTuples(chainId);
  }
}
