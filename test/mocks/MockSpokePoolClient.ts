import { clients, interfaces } from "@across-protocol/sdk";
import { Deposit, RootBundleRelayWithBlock } from "../../src/interfaces";

export class MockSpokePoolClient extends clients.mocks.MockSpokePoolClient {
  public maxFillDeadlineOverride?: number;
  public blockTimestampOverride: Record<number, number> = {};
  private relayFillStatuses: Record<string, interfaces.FillStatus> = {};
  rootBundleRelays: RootBundleRelayWithBlock[] = [];

  public setMaxFillDeadlineOverride(maxFillDeadlineOverride?: number): void {
    this.maxFillDeadlineOverride = maxFillDeadlineOverride;
  }

  public async getMaxFillDeadlineInRange(startBlock: number, endBlock: number): Promise<number> {
    return this.maxFillDeadlineOverride ?? super.getMaxFillDeadlineInRange(startBlock, endBlock);
  }

  public setBlockTimestamp(block: number, timestamp: number): void {
    this.blockTimestampOverride[block] = timestamp;
  }

  public async getTimeAt(block: number): Promise<number> {
    return Promise.resolve(this.blockTimestampOverride[block]) ?? super.getTimeAt(block);
  }

  setRootBundleRelays(rootBundleRelays: RootBundleRelayWithBlock[]): void {
    this.rootBundleRelays = rootBundleRelays;
  }

  getRootBundleRelays(): RootBundleRelayWithBlock[] {
    return this.rootBundleRelays.length > 0 ? this.rootBundleRelays : super.getRootBundleRelays();
  }

  public setRelayFillStatus(deposit: Deposit, fillStatus: interfaces.FillStatus): void {
    const relayDataHash = deposit.depositId.toString();
    this.relayFillStatuses[relayDataHash] = fillStatus;
  }
  public relayFillStatus(
    relayData: interfaces.RelayData,
    blockTag?: number,
  ): Promise<interfaces.FillStatus> {
    const relayDataHash = relayData.depositId.toString();
    return this.relayFillStatuses[relayDataHash]
      ? Promise.resolve(this.relayFillStatuses[relayDataHash])
      : super.relayFillStatus(relayData, blockTag);
  }
}
