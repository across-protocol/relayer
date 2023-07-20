import { clients, interfaces } from "@across-protocol/sdk-v2";
import { UBAClient } from "../../src/clients";
import { BigNumber, toBN } from "../utils";
import { UBASystemFee } from "../../src/interfaces";

// Adds functions to MockHubPoolClient to facilitate Dataworker unit testing.
export class MockUBAClient extends UBAClient {
  public readonly balancingFees: { [chainId: number]: BigNumber } = {};
  public readonly lpFees: { [chainId: number]: BigNumber } = {};
  public readonly flows: { [chainId: number]: { [token: string]: clients.ModifiedUBAFlow[] } } = {};

  setBalancingFee(chainId: number, fee: BigNumber): void {
    this.balancingFees[chainId] = fee;
  }

  _getBalancingFee(chainId: number): BigNumber {
    return this.balancingFees[chainId] ?? toBN(0);
  }

  setLpFee(chainId: number, fee: BigNumber): void {
    this.lpFees[chainId] = fee;
  }

  _computeLpFee(chain: number): BigNumber {
    return this.lpFees[chain] ?? toBN(0);
  }

  computeFeesForDeposit(deposit: interfaces.UbaInflow): {
    systemFee: UBASystemFee;
    relayerFee: clients.RelayerFeeResult;
  } {
    const lpFee = this._computeLpFee(deposit.originChainId);
    const depositBalancingFee = this._getBalancingFee(deposit.originChainId);
    const relayerBalancingFee = this._getBalancingFee(deposit.destinationChainId);
    return {
      systemFee: {
        systemFee: lpFee.add(depositBalancingFee),
        lpFee,
        depositBalancingFee,
      },
      relayerFee: {
        relayerBalancingFee,
      },
    };
  }

  setFlows(chainId: number, token: string, modifiedFlows: clients.ModifiedUBAFlow[]): void {
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
  ): clients.ModifiedUBAFlow[] {
    return this.flows[chainId]?.[tokenSymbol] ?? [];
  }
}
