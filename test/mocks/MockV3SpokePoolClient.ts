import { clients } from "@across-protocol/sdk-v2";
import { EventFilter } from "ethers";
export class MockV3SpokePoolClient extends clients.mocks.MockSpokePoolClient {
  public maxFillDeadlineOverride?: number;
  public oldestBlockTimestampOverride?: number;

  // TODO: Might need to fix this
  public _queryableEventNames(): { [eventName: string]: EventFilter } {
    return {
      FundsDeposited: this.spokePool.filters.V3FundsDeposited(),
      RequestedSpeedUpDeposit: this.spokePool.filters.RequestedSpeedUpV3Deposit(),
      FilledRelay: this.spokePool.filters.FilledV3Relay(),
      EnabledDepositRoute: this.spokePool.filters.EnabledDepositRoute(),
      TokensBridged: this.spokePool.filters.TokensBridged(),
      RelayedRootBundle: this.spokePool.filters.RelayedRootBundle(),
      ExecutedRelayerRefundRoot: this.spokePool.filters.ExecutedV3RelayerRefundRoot(),
    };
  }

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
