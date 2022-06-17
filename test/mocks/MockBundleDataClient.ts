import { BundleDataClient } from "../../src/clients";
import { FillsToRefund } from "../../src/interfaces";

export class MockBundleDataClient extends BundleDataClient {
  private pendingBundleRefunds: FillsToRefund = {};
  private nextBundleRefunds: FillsToRefund = {};

  getPendingRefundsFromLatestBundle() {
    return this.pendingBundleRefunds;
  }

  getNextBundleRefunds() {
    return this.nextBundleRefunds;
  }

  setReturnedPendingBundleRefunds(refunds: FillsToRefund) {
    this.pendingBundleRefunds = refunds;
  }

  setReturnedNextBundleRefunds(refunds: FillsToRefund) {
    this.nextBundleRefunds = refunds;
  }
}
