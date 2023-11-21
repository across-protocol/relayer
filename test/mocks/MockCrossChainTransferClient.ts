import { BigNumber } from "ethers";
import { CrossChainTransferClient } from "../../src/clients/bridges";
export class MockCrossChainTransferClient extends CrossChainTransferClient {
  crossChainTransferAmount: BigNumber = BigNumber.from(0);
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
