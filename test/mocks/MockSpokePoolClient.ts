import { clients } from "@across-protocol/sdk-v2";
export class MockSpokePoolClient extends clients.mocks.MockSpokePoolClient {
  public maxFillDeadlineOverride?: number;
  public oldestBlockTimestampOverride?: number;

  public setMaxFillDeadlineOverride(maxFillDeadlineOverride?: number): void {
    this.maxFillDeadlineOverride = maxFillDeadlineOverride;
  }

  public async getMaxFillDeadlineInRange(startBlock: number, endBlock: number): Promise<number> {
    if (this.maxFillDeadlineOverride !== undefined) {
      return this.maxFillDeadlineOverride;
    } else {
      return super.getMaxFillDeadlineInRange(startBlock, endBlock);
    }
  }

  public setOldestBlockTimestampOverride(oldestBlockTimestampOverride?: number): void {
    this.oldestBlockTimestampOverride = oldestBlockTimestampOverride;
  }

  public getOldestTime(): number {
    if (this.oldestBlockTimestampOverride !== undefined) {
      return this.oldestBlockTimestampOverride;
    } else {
      return super.getOldestTime();
    }
  }
}
