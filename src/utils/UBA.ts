import { DepositWithBlock, FillWithBlock, UbaFlow } from "../interfaces";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { assert } from "../utils";
import { sortEventsAscending } from "./";

export class UBAClient {
  // @dev chainIdIndices supports indexing members of root bundle proposals submitted to the HubPool.
  //      It must include the complete set of chain IDs ever supported by the HubPool.
  // @dev SpokePoolClients may be a subset of the SpokePools that have been deployed.
  constructor(
    private readonly chainIdIndices: number[],
    private readonly hubPoolClient: HubPoolClient,
    private readonly spokePoolClients: { [chainId: number]: SpokePoolClient }
  ) {
    assert(chainIdIndices.length > 0, "No chainIds provided");
    assert(Object.values(spokePoolClients).length > 0, "No SpokePools provided");
  }

  /**
   * @description Construct the ordered sequence of SpokePool flows between two blocks.
   * @note Assumptions:
   * @note Deposits, Fills and RefundRequests have been pre-verified by the SpokePool contract or SpokePoolClient, i.e.:
   * @note - Deposit events contain valid information.
   * @note - Fill events correspond to valid deposits.
   * @note - RefundRequest events correspond to valid fills.
   * @note In order to provide up-to-date prices, UBA functionality may want to follow close to "latest" and so may still
   * @note be exposed to finality risk. Additional verification that can only be performed within the UBA context:
   * @note - Only the first instance of a partial fill for a deposit is accepted. The total deposit amount is taken, and
   * @note   subsequent partial, complete or slow fills are disregarded.
   * @param spokePoolClient SpokePoolClient instance for this chain.
   * @param fromBlock       Optional lower bound of the search range. Defaults to the SpokePool deployment block.
   * @param toBlock         Optional upper bound of the search range. Defaults to the latest queried block.
   */
  getFlows(chainId: number, fromBlock?: number, toBlock?: number): UbaFlow[] {
    const spokePoolClient = this.spokePoolClients[chainId];
    fromBlock ??= spokePoolClient.deploymentBlock;
    toBlock ??= spokePoolClient.latestBlockNumber;

    const deposits: UbaFlow[] = spokePoolClient
      .getDeposits()
      .filter((deposit: DepositWithBlock) => deposit.blockNumber >= fromBlock && deposit.blockNumber <= toBlock);

    // Filter out:
    // - Fills that request refunds on a different chain.
    // - Subsequent fills after an initial partial fill.
    // - Slow fills.
    const fills: UbaFlow[] = spokePoolClient.getFills().filter((fill: FillWithBlock) => {
      const result =
        fill.repaymentChainId === spokePoolClient.chainId &&
        fill.fillAmount.eq(fill.totalFilledAmount) &&
        fill.updatableRelayData.isSlowRelay === false &&
        fill.blockNumber > fromBlock &&
        fill.blockNumber < toBlock;
      return result;
    });

    const refundRequests: UbaFlow[] = spokePoolClient.getRefundRequests(fromBlock, toBlock);

    // This is probably more expensive than we'd like... @todo: optimise.
    const flows = sortEventsAscending(deposits.concat(fills).concat(refundRequests));

    return flows;
  }
}
