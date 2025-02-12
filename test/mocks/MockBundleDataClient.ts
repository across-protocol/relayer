import { BundleDataClient, SpokePoolClient } from "../../src/clients";
import { CombinedRefunds } from "../../src/dataworker/DataworkerUtils";
import { DepositWithBlock, FillWithBlock } from "../../src/interfaces";
import { getRelayEventKey } from "../../src/utils";

export class MockBundleDataClient extends BundleDataClient {
  private pendingBundleRefunds: CombinedRefunds = {};
  private nextBundleRefunds: CombinedRefunds = {};
  private matchingFillEvents: Record<string, FillWithBlock> = {};

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

  setMatchingFillEvent(deposit: DepositWithBlock, fill: FillWithBlock): void {
    const relayDataHash = getRelayEventKey(deposit);
    this.matchingFillEvents[relayDataHash] = fill;
  }

  findMatchingFillEvent(
    deposit: DepositWithBlock,
    spokePoolClient: SpokePoolClient
  ): Promise<FillWithBlock | undefined> {
    const relayDataHash = getRelayEventKey(deposit);
    return this.matchingFillEvents[relayDataHash]
      ? Promise.resolve(this.matchingFillEvents[relayDataHash])
      : super.findMatchingFillEvent(deposit, spokePoolClient);
  }
}
