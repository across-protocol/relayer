import { BundleDataClient } from "../../src/clients";
import { CombinedRefunds } from "../../src/dataworker/DataworkerUtils";

export class MockBundleDataClient extends BundleDataClient {
  private pendingBundleRefunds: CombinedRefunds = {};
  private nextBundleRefunds: CombinedRefunds = {};

  async getPendingRefundsFromValidBundles(): Promise<CombinedRefunds[]> {
    return [this.pendingBundleRefunds];
  }

  async getNextBundleRefunds(): Promise<CombinedRefunds[]> {
    return [this.nextBundleRefunds];
  }

  setReturnedPendingBundleRefunds(refunds: CombinedRefunds): void {
    this.pendingBundleRefunds = refunds;
  }

  setReturnedNextBundleRefunds(refunds: CombinedRefunds): void {
    this.nextBundleRefunds = refunds;
  }

  getPersistedPendingRefundsFromLastValidBundle(): Promise<CombinedRefunds[] | undefined> {
    return Promise.resolve(undefined);
  }

  getPersistedNextBundleRefunds(): Promise<CombinedRefunds | undefined> {
    return Promise.resolve(undefined);
  }
}
