import * as ubaClientSdk from "@across-protocol/sdk-v2/dist/clients/UBAClient";
import { UBAClient } from "../../src/clients";
import { BigNumber, toBN } from "../utils";

// Adds functions to MockHubPoolClient to facilitate Dataworker unit testing.
export class MockUBAClient extends UBAClient {
  public readonly balancingFees: { [chainId: number]: BigNumber } = {};
  public readonly lpFees: { [chainId: number]: BigNumber } = {};
  public readonly flows: { [chainId: number]: { [token: string]: ubaClientSdk.ModifiedUBAFlow[] } } = {};

  setBalancingFee(chainId: number, fee: BigNumber): void {
    this.balancingFees[chainId] = fee;
  }

  computeBalancingFee(
    _spokePoolToken: string,
    _amount: BigNumber,
    _hubPoolBlockNumber: number,
    chainId: number,
    feeType: ubaClientSdk.UBAActionType
  ): ubaClientSdk.BalancingFeeReturnType {
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
  ): ubaClientSdk.SystemFeeResult {
    const hubPoolToken = ""; // ignored
    // @dev pass in anything for hubPoolChainId since it's not used
    const lpFee = this.computeLpFee(amount, depositChainId, depositChainId, hubPoolToken, destinationChainId);

    const { balancingFee: depositBalancingFee } = this.computeBalancingFee(
      spokePoolToken,
      amount,
      hubPoolBlockNumber,
      depositChainId,
      ubaClientSdk.UBAActionType.Deposit
    );
    const systemFee = lpFee.add(depositBalancingFee);

    return { lpFee, depositBalancingFee, systemFee };
  }
  setFlows(chainId: number, token: string, modifiedFlows: ubaClientSdk.ModifiedUBAFlow[]): void {
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
  ): ubaClientSdk.ModifiedUBAFlow[] {
    return this.flows[chainId]?.[tokenSymbol] ?? [];
  }
}
