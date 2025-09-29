import { BigNumber } from "../utils";
import { bnZero } from "../../src/utils";

export class MockQuery {
  private auxNativeTokenCostByChain: { [chainId: number]: BigNumber } = {};

  setAuxiliaryNativeTokenCost(chainId: number, cost: BigNumber): void {
    this.auxNativeTokenCostByChain[chainId] = cost;
  }

  getAuxiliaryNativeTokenCost(deposit: { destinationChainId: number }): BigNumber {
    return this.auxNativeTokenCostByChain[deposit.destinationChainId] ?? bnZero;
  }
}
