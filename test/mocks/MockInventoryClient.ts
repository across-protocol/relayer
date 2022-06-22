import { Deposit } from "../../src/interfaces";
import { InventoryClient } from "../../src/clients";
import { BigNumber, toBN } from "../utils";
export class MockInventoryClient extends InventoryClient {
  partialFillAmount: BigNumber;
  constructor() {
    super(null, null, null, null, null, null, null, null);
    this.partialFillAmount = toBN(0);
  }

  determineRefundChainId(deposit: Deposit) {
    return 1;
  }

  setPartialFillAmount(amount: BigNumber) {
    this.partialFillAmount = amount;
  }

  getPartialFillAmount(deposit: Deposit, unfilledAmount: BigNumber) {
    return this.partialFillAmount;
  }
}
