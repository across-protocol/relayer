import { BigNumber, bnZero } from "../../src/utils";
import { CrossChainTransferClient } from "../../src/clients/bridges";
export class MockCrossChainTransferClient extends CrossChainTransferClient {
  crossChainTransferAmount = bnZero;
  constructor() {
    super(null, null, null);
  }

  setCrossChainTransferAmount(amount: BigNumber): void {
    this.crossChainTransferAmount = amount;
  }

  getOutstandingCrossChainTransferAmount(): BigNumber {
    return this.crossChainTransferAmount;
  }

  getOutstandingCrossChainTransferTxs(): string[] {
    return [];
  }
}
