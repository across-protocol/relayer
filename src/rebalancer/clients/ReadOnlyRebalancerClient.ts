import { BaseRebalancerClient } from "./BaseRebalancerClient";

export class ReadOnlyRebalancerClient extends BaseRebalancerClient {
  override async rebalanceInventory(): Promise<void> {
    throw new Error("ReadOnlyRebalancerClient does not support rebalancing inventory");
  }
}
