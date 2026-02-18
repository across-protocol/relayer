import { RebalancerClient } from "../../src/rebalancer/rebalancer";
import { BigNumber } from "../../src/utils";
import { winston } from "../utils";

export class MockRebalancerClient extends RebalancerClient {
  private mockedPendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

  constructor(logger: winston.Logger) {
    super(logger, null, null, null, null);
  }

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  setPendingRebalances(pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } }): void {
    this.mockedPendingRebalances = pendingRebalances;
  }

  setPendingRebalance(chainId: number, token: string, amount: BigNumber): void {
    this.mockedPendingRebalances[chainId] ??= {};
    this.mockedPendingRebalances[chainId][token] = amount;
  }

  clearPendingRebalances(): void {
    this.mockedPendingRebalances = {};
  }

  getPendingRebalances(): ReturnType<RebalancerClient["getPendingRebalances"]> {
    return Promise.resolve(this.mockedPendingRebalances);
  }
}
