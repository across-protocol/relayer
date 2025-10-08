import { BigNumber } from "../utils";
import { chainIsSvm } from "../../src/utils";
import { Deposit } from "../../src/interfaces";
import { arch } from "@across-protocol/sdk";

export class MockQuery {
  private auxNativeTokenCostByChain: { [chainId: number]: BigNumber } = {};

  setAuxiliaryNativeTokenCost(chainId: number, cost: BigNumber): void {
    this.auxNativeTokenCostByChain[chainId] = cost;
  }

  getAuxiliaryNativeTokenCost(deposit: Deposit): BigNumber {
    const chainId = deposit.destinationChainId;
    return chainIsSvm(chainId)
      ? arch.svm.getAuxiliaryNativeTokenCost(deposit)
      : arch.evm.getAuxiliaryNativeTokenCost(deposit);
  }
}
