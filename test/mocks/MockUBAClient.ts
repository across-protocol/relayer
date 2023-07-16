import { clients } from "@across-protocol/sdk-v2";
import { HubPoolClient, UBAClient } from "../../src/clients";
import { BigNumber, toBN } from "../utils";
import { SpokePoolClientsByChain, UBABalancingFee, UBASystemFee } from "../../src/interfaces";

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
  async computeLpFee(
    _hubPoolBlockNumber: number,
    _amount: BigNumber,
    depositChainId: number,
    _refundChainId: number,
    _hubPoolChainId: number,
    _tokenSymbol: string,
    hubPoolClient: HubPoolClient,
    spokePoolClients: SpokePoolClientsByChain
  ): Promise<BigNumber> {
    // Ignore destinationChainId
    return this.getLpFee(depositChainId);
  }

  getLpFee(chainId: number): BigNumber {
    return this.lpFees[chainId] ?? toBN(0);
  }

  /* eslint-enable @typescript-eslint/no-unused-vars */
  async computeSystemFee(
    depositChainId: number,
    destinationChainId: number,
    tokenSymbol: string,
    hubPoolClient: HubPoolClient,
    spokePoolClients: SpokePoolClientsByChain,
    amount: BigNumber,
    hubPoolBlockNumber: number
  ): Promise<UBASystemFee> {
    const lpFee = await this.computeLpFee(
      hubPoolBlockNumber,
      amount,
      depositChainId,
      destinationChainId,
      hubPoolClient.chainId,
      tokenSymbol,
      hubPoolClient,
      spokePoolClients
    );

    const { balancingFee: depositBalancingFee } = this.computeBalancingFee(
      tokenSymbol,
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
