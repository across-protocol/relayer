import { utils as sdkUtils } from "@across-protocol/sdk";
import { BigNumber } from "../utils";
import { bnZero } from "../../src/utils";

type TransactionCostEstimate = sdkUtils.TransactionCostEstimate;

export class MockQuery {
  private gasCostsByChain: { [chainId: number]: TransactionCostEstimate } = {};
  private auxNativeTokenCostByChain: { [chainId: number]: BigNumber } = {};

  setGasCost(chainId: number, gasCost?: TransactionCostEstimate): void {
    if (gasCost) {
      this.gasCostsByChain[chainId] = gasCost;
    } else {
      delete this.gasCostsByChain[chainId];
    }
  }

  setAuxiliaryNativeTokenCost(chainId: number, cost: BigNumber): void {
    this.auxNativeTokenCostByChain[chainId] = cost;
  }

  getGasCosts(deposit: { destinationChainId: number }): TransactionCostEstimate {
    const cost = this.gasCostsByChain[deposit.destinationChainId];
    if (!cost) {
      // Mirror real query behavior by throwing when unavailable so caller can fall back.
      throw new Error("MockQuery: gas cost unavailable for chain");
    }
    return cost;
  }

  getAuxiliaryNativeTokenCost(deposit: { destinationChainId: number }): BigNumber {
    return this.auxNativeTokenCostByChain[deposit.destinationChainId] ?? bnZero;
  }
}
