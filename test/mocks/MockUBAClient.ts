import { clients as sdkClients } from "@across-protocol/sdk-v2";
import * as UBAClientTypes from "@across-protocol/sdk-v2/src/clients/UBAClient/UBAClientTypes";
import { UBAClient } from "../../src/clients";
// import { UBABalancingFee, UBASystemFee } from "../../src/interfaces";
import { BigNumber, toBN } from "../utils";
import { ModifiedUBAFlow } from "@across-protocol/sdk-v2/dist/clients/UBAClient/UBAClientTypes";

type UBAActionType = sdkClients.UBAActionType;
// const { UBAActionType } = sdkClients;

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
    fromBlock?: number | undefined,
    toBlock?: number | undefined
  ): ModifiedUBAFlow[] {
    return this.flows[chainId]?.[tokenSymbol] ?? [];
  }

  // async computeBalancingFee(
  //   _spokePoolToken: string,
  //   _amount: BigNumber,
  //   _hubPoolBlockNumber: number,
  //   chainId: number,
  //   feeType: UBAActionType
  // ): Promise<UBABalancingFee> {
  //   return { balancingFee: this.getBalancingFee(chainId), feeType };
  // }

  // /* eslint-disable @typescript-eslint/no-unused-vars */
  // async computeLpFee(
  //   _hubPoolTokenAddress: string,
  //   depositChainId: number,
  //   _destinationChainId: number,
  //   _amount: BigNumber
  // ): Promise<BigNumber> {
  //   // Ignore destinationChainId
  //   return this.getLpFee(depositChainId);
  // }
  // /* eslint-enable @typescript-eslint/no-unused-vars */

  // async computeSystemFee(
  //   depositChainId: number,
  //   destinationChainId: number,
  //   spokePoolToken: string,
  //   amount: BigNumber,
  //   hubPoolBlockNumber: number
  // ): Promise<UBASystemFee> {
  //   const hubPoolToken = ""; // ignored
  //   const lpFee = await this.computeLpFee(hubPoolToken, depositChainId, destinationChainId, amount);

  //   const { balancingFee: depositBalancingFee } = await this.computeBalancingFee(
  //     spokePoolToken,
  //     amount,
  //     hubPoolBlockNumber,
  //     depositChainId,
  //     UBAActionType.Deposit
  //   );
  //   const systemFee = lpFee.add(depositBalancingFee);

  //   return { lpFee, depositBalancingFee, systemFee };
  // }
}
