import { BundleDataClient } from "../../src/clients";
import { FillsToRefund } from "../../src/interfaces";

export class MockBundleDataClient extends BundleDataClient {
  private pendingBundleRefunds: FillsToRefund = {};
  private nextBundleRefunds: FillsToRefund = {};

  async getPendingRefundsFromValidBundles(): Promise<FillsToRefund[]> {
    return [this.pendingBundleRefunds];
  }

  async getNextBundleRefunds(): Promise<FillsToRefund> {
    return this.nextBundleRefunds;
  }

  setReturnedPendingBundleRefunds(refunds: FillsToRefund): void {
    this.pendingBundleRefunds = refunds;
  }

  setReturnedNextBundleRefunds(refunds: FillsToRefund): void {
    this.nextBundleRefunds = refunds;
  }
}
