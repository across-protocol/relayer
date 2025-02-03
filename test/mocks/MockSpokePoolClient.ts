import { clients, interfaces } from "@across-protocol/sdk";
import { Deposit } from "../../src/interfaces";
export class MockSpokePoolClient extends clients.mocks.MockSpokePoolClient {
  public maxFillDeadlineOverride?: number;
  public oldestBlockTimestampOverride?: number;
  private relayFillStatuses: Record<string, interfaces.FillStatus> = {};

  public setMaxFillDeadlineOverride(maxFillDeadlineOverride?: number): void {
    this.maxFillDeadlineOverride = maxFillDeadlineOverride;
  }

  public async getMaxFillDeadlineInRange(startBlock: number, endBlock: number): Promise<number> {
    return this.maxFillDeadlineOverride ?? super.getMaxFillDeadlineInRange(startBlock, endBlock);
  }

  public setOldestBlockTimestampOverride(oldestBlockTimestampOverride?: number): void {
    this.oldestBlockTimestampOverride = oldestBlockTimestampOverride;
  }

  public getOldestTime(): number {
    return this.oldestBlockTimestampOverride ?? super.getOldestTime();
  }

  public setRelayFillStatus(deposit: Deposit, fillStatus: interfaces.FillStatus): void {
    const relayDataHash = deposit.depositId.toString();
    this.relayFillStatuses[relayDataHash] = fillStatus;
  }
  public relayFillStatus(
    relayData: interfaces.RelayData,
    blockTag?: number | "latest",
    destinationChainId?: number
  ): Promise<interfaces.FillStatus> {
    const relayDataHash = relayData.depositId.toString();
    return this.relayFillStatuses[relayDataHash]
      ? Promise.resolve(this.relayFillStatuses[relayDataHash])
      : super.relayFillStatus(relayData, blockTag, destinationChainId);
  }
}
