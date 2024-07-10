import { clients } from "@across-protocol/sdk";
export class MockSpokePoolClient extends clients.mocks.MockSpokePoolClient {
  public maxFillDeadlineOverride?: number;
  public oldestBlockTimestampOverride?: number;

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
}
