import * as UBAClientTypes from "@across-protocol/sdk-v2/src/clients/UBAClient/UBAClientTypes";
import { UBAClient } from "../../src/clients";
import { BigNumber, toBN } from "../utils";

// Adds functions to MockHubPoolClient to facilitate Dataworker unit testing.
export class MockUBAClient extends UBAClient {
  public readonly balancingFees: { [chainId: number]: BigNumber } = {};
  public readonly lpFees: { [chainId: number]: BigNumber } = {};
  public readonly flows: { [chainId: number]: { [token: string]: UBAClientTypes.ModifiedUBAFlow[] } } = {};

  setBalancingFee(chainId: number, fee: BigNumber): void {
    this.balancingFees[chainId] = fee;
  }

  getBalancingFee(chainId: number): BigNumber {
    return this.balancingFees[chainId] ?? toBN(0);
  }

  setLpFee(chainId: number, fee: BigNumber): void {
    this.lpFees[chainId] = fee;
  }

  getLpFee(chainId: number): BigNumber {
    return this.lpFees[chainId] ?? toBN(0);
  }

  setFlows(chainId: number, token: string, modifiedFlows: UBAClientTypes.ModifiedUBAFlow[]): void {
    if (!this.flows[chainId]) {
      this.flows[chainId] = {};
    }
    this.flows[chainId][token] = modifiedFlows;
  }

  getModifiedFlows(
    chainId: number,
    tokenSymbol: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _fromBlock?: number | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _toBlock?: number | undefined
  ): UBAClientTypes.ModifiedUBAFlow[] {
    return this.flows[chainId]?.[tokenSymbol] ?? [];
  }
}
