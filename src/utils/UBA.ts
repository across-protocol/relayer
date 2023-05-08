import { DepositWithBlock, FillWithBlock, UbaFlow } from "../interfaces";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { assert, BigNumber, isDefined } from "../utils";
import { sortEventsAscending } from "./";

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
export function getUBAFlows(spokePoolClient: SpokePoolClient, fromBlock?: number, toBlock?: number): UbaFlow[] {
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

export class UBAClient {
  private closingBlockNumbers: { [chainId: number]: number[] };

  constructor(
    private readonly chainIds: number[],
    private readonly hubPoolClient: HubPoolClient,
    private readonly spokePoolClients: { [chainId: number]: SpokePoolClient }
  ) {
    assert(chainIds.length > 0, "No chainIds provided");
    assert(Object.values(spokePoolClients).length > 0, "No SpokePools provided");
    this.closingBlockNumbers = Object.fromEntries(this.chainIds.map((chainId) => [chainId, []]));
  }

  private resolveClosingBlockNumber(chainId: number, blockNumber: number): number {
    const endBlock = this.hubPoolClient.getLatestBundleEndBlockForChain(this.chainIds, blockNumber, chainId);
    return endBlock ?? this.spokePoolClients[chainId].deploymentBlock;
  }

  getOpeningBalance(
    chainId: number,
    spokePoolToken: string,
    hubPoolBlockNumber?: number
  ): { balance: BigNumber; blockNumber: number } {
    assert(Array.isArray(this.closingBlockNumbers[chainId]), `Invalid chainId: ${chainId}`);

    hubPoolBlockNumber ??= this.hubPoolClient.latestBlockNumber;

    const hubPoolToken = this.hubPoolClient.getL1TokenCounterpartAtBlock(chainId, spokePoolToken, hubPoolBlockNumber);
    if (!isDefined(hubPoolToken)) {
      throw new Error(`Could not resolve ${chainId} token ${spokePoolToken} at block ${hubPoolBlockNumber}`);
    }

    const prevEndBlock = this.resolveClosingBlockNumber(chainId, hubPoolBlockNumber);
    const blockNumber =
      prevEndBlock > this.hubPoolClient.deploymentBlock ? prevEndBlock + 1 : this.hubPoolClient.deploymentBlock;
    const balance = this.hubPoolClient.getRunningBalanceBeforeBlockForChain(hubPoolBlockNumber, chainId, hubPoolToken);

    return { blockNumber, balance };
  }
}
