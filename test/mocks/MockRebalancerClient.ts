import { BaseRebalancerClient } from "../../src/rebalancer/clients/BaseRebalancerClient";
import { BigNumber } from "../../src/utils";
import { winston } from "../utils";

export class MockRebalancerClient extends BaseRebalancerClient {
  private mockedPendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

  constructor(logger: winston.Logger) {
    super(logger, {} as never, {}, [], {} as never);
  }

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  rebalanceInventory(): Promise<void> {
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

  getPendingRebalances(): ReturnType<BaseRebalancerClient["getPendingRebalances"]> {
    return Promise.resolve(this.mockedPendingRebalances);
  }
}
