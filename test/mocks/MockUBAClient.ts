import { clients } from "@across-protocol/sdk-v2";
import { UBAClient } from "../../src/clients";
import { BigNumber, toBN } from "../utils";
import { UBABalancingFee, UBASystemFee } from "../../src/interfaces";

// Adds functions to MockHubPoolClient to facilitate Dataworker unit testing.
export class MockUBAClient extends UBAClient {
  public readonly balancingFees: { [chainId: number]: BigNumber } = {};
  public readonly lpFees: { [chainId: number]: BigNumber } = {};
  public readonly flows: { [chainId: number]: { [token: string]: clients.ModifiedUBAFlow[] } } = {};

  setBalancingFee(chainId: number, fee: BigNumber): void {
    this.balancingFees[chainId] = fee;
  }

  computeBalancingFee(
    _spokePoolToken: string,
    _amount: BigNumber,
    _hubPoolBlockNumber: number,
    chainId: number,
    feeType: clients.UBAActionType
  ): UBABalancingFee {
    return { balancingFee: this.getBalancingFee(chainId), actionType: feeType };
  }

  getBalancingFee(chainId: number): BigNumber {
    return this.balancingFees[chainId] ?? toBN(0);
  }

  setLpFee(chainId: number, fee: BigNumber): void {
    this.lpFees[chainId] = fee;
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  computeLpFee(
    _amount: BigNumber,
    depositChainId: number,
    _hubPoolChainId: number,
    _tokenSymbol: string,
    _refundChainId: number
  ): BigNumber {
    // Ignore destinationChainId
    return this.getLpFee(depositChainId);
  }

  getLpFee(chainId: number): BigNumber {
    return this.lpFees[chainId] ?? toBN(0);
  }

  /* eslint-enable @typescript-eslint/no-unused-vars */
  computeSystemFee(
    depositChainId: number,
    destinationChainId: number,
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number
  ): UBASystemFee {
    const hubPoolToken = ""; // ignored
    // @dev pass in anything for hubPoolChainId since it's not used
    const lpFee = this.computeLpFee(amount, depositChainId, depositChainId, hubPoolToken, destinationChainId);

    const { balancingFee: depositBalancingFee } = this.computeBalancingFee(
      spokePoolToken,
      amount,
      hubPoolBlockNumber,
      depositChainId,
      clients.UBAActionType.Deposit
    );
    const systemFee = lpFee.add(depositBalancingFee);

    return { lpFee, depositBalancingFee, systemFee };
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
