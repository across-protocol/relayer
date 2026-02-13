import { RebalancerClient } from "../../src/rebalancer/rebalancer";
import { winston } from "../utils";

export class MockRebalancerClient extends RebalancerClient {
  constructor(logger: winston.Logger) {
    super(logger, null, null, null, null);
  }

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  getPendingRebalances(): ReturnType<RebalancerClient["getPendingRebalances"]> {
    return Promise.resolve({});
  }
}
