import { BundleDataClient } from "../../src/clients";
import { FillsToRefund } from "../../src/interfaces";

export class MockBundleDataClient extends BundleDataClient {
  private pendingBundleRefunds: FillsToRefund = {};
  private nextBundleRefunds: FillsToRefund = {};

  getPendingRefundsFromValidBundles(): Promise<FillsToRefund[]> {
    return Promise.resolve([this.pendingBundleRefunds]);
  }

  getNextBundleRefunds(): Promise<FillsToRefund> {
    return Promise.resolve(this.nextBundleRefunds);
  }

  setReturnedPendingBundleRefunds(refunds: FillsToRefund): void {
    this.pendingBundleRefunds = refunds;
  }

  setReturnedNextBundleRefunds(refunds: FillsToRefund): void {
    this.nextBundleRefunds = refunds;
  }
}
