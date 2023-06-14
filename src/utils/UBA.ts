import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock, UbaFlow } from "../interfaces";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { assert, BigNumber, isDefined, winston } from "../utils";
import { sortEventsAscending } from "./";

export class UBAClient {
  // @dev chainIdIndices supports indexing members of root bundle proposals submitted to the HubPool.
  //      It must include the complete set of chain IDs ever supported by the HubPool.
  // @dev SpokePoolClients may be a subset of the SpokePools that have been deployed.
  constructor(
    private readonly chainIdIndices: number[],
    private readonly hubPoolClient: HubPoolClient,
    private readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    private readonly logger?: winston.Logger
  ) {
    assert(chainIdIndices.length > 0, "No chainIds provided");
    assert(Object.values(spokePoolClients).length > 0, "No SpokePools provided");
  }

  private resolveClosingBlockNumber(chainId: number, blockNumber: number): number {
    return this.hubPoolClient.getLatestBundleEndBlockForChain(this.chainIdIndices, blockNumber, chainId);
  }

  getOpeningBalance(
    chainId: number,
    spokePoolToken: string,
    hubPoolBlockNumber?: number
  ): { blockNumber: number; spokePoolBalance: BigNumber } {
    hubPoolBlockNumber = hubPoolBlockNumber ?? this.hubPoolClient.latestBlockNumber;

    const hubPoolToken = this.hubPoolClient.getL1TokenCounterpartAtBlock(chainId, spokePoolToken, hubPoolBlockNumber);
    if (!isDefined(hubPoolToken)) {
      throw new Error(`Could not resolve ${chainId} token ${spokePoolToken} at block ${hubPoolBlockNumber}`);
    }

    const spokePoolClient = this.spokePoolClients[chainId];
    const prevEndBlock = this.resolveClosingBlockNumber(chainId, hubPoolBlockNumber);
    let blockNumber = spokePoolClient.deploymentBlock;
    if (prevEndBlock > blockNumber) {
      blockNumber = prevEndBlock + 1;
      assert(blockNumber <= spokePoolClient.latestBlockNumber);
    }
    const spokePoolBalance = this.hubPoolClient.getRunningBalanceBeforeBlockForChain(
      hubPoolBlockNumber,
      chainId,
      hubPoolToken
    );

    return { blockNumber, spokePoolBalance };
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

    const refundRequests: UbaFlow[] = spokePoolClient.getRefundRequests(fromBlock, toBlock).filter((refundRequest) => {
      const { valid, reason } = this.refundRequestIsValid(chainId, refundRequest);
      if (!valid && this.logger !== undefined) {
        this.logger.info({
          at: "UBAClient::getFlows",
          message: `Excluding RefundRequest on chain ${chainId}`,
          reason,
          refundRequest,
        });
      }

      return valid;
    });

    // This is probably more expensive than we'd like... @todo: optimise.
    const flows = sortEventsAscending(deposits.concat(fills).concat(refundRequests));

    return flows;
  }

  /**
   * @description Evaluate an RefundRequest object for validity.
   * @dev  Callers should evaluate 'valid' before 'reason' in the return object.
   * @dev  The following RefundRequest attributes are not evaluated for validity and should be checked separately:
   * @dev  - previousIdenticalRequests
   * @dev  - Age of blockNumber (i.e. according to SpokePool finality)
   * @param chainId       ChainId of SpokePool where refundRequest originated.
   * @param refundRequest RefundRequest object to be evaluated for validity.
   */
  refundRequestIsValid(chainId: number, refundRequest: RefundRequestWithBlock): { valid: boolean; reason?: string } {
    const { relayer, amount, refundToken, depositId, originChainId, destinationChainId, realizedLpFeePct, fillBlock } =
      refundRequest;

    if (!this.chainIdIndices.includes(originChainId)) {
      return { valid: false, reason: "Invalid originChainId" };
    }
    const originSpoke = this.spokePoolClients[originChainId];

    if (!this.chainIdIndices.includes(destinationChainId) || destinationChainId === chainId) {
      return { valid: false, reason: "Invalid destinationChainId" };
    }
    const destSpoke = this.spokePoolClients[destinationChainId];

    if (fillBlock.lt(destSpoke.deploymentBlock) || fillBlock.gt(destSpoke.latestBlockNumber)) {
      return {
        valid: false,
        reason:
          `FillBlock (${fillBlock} out of SpokePool range` +
          ` [${destSpoke.deploymentBlock}, ${destSpoke.latestBlockNumber}]`,
      };
    }

    // Validate relayer and depositId.
    const fill = destSpoke.getFillsForRelayer(relayer).find((fill) => {
      // prettier-ignore
      return (
        fill.depositId === depositId
        && fill.originChainId === originChainId
        && fill.destinationChainId === destinationChainId
        && fill.amount.eq(amount)
        && fill.realizedLpFeePct.eq(realizedLpFeePct)
        && fill.blockNumber === fillBlock.toNumber()
      );
    });
    if (!isDefined(fill)) {
      return { valid: false, reason: "Unable to find matching fill" };
    }

    const deposit = originSpoke.getDepositForFill(fill);
    if (!isDefined(deposit)) {
      return { valid: false, reason: "Unable to find matching deposit" };
    }

    // Verify that the refundToken maps to a known HubPool token.
    // Note: the refundToken must be valid at the time of the Fill *and* the RefundRequest.
    // @todo: Resolve to the HubPool block number at the time of the RefundRequest ?
    const hubPoolBlockNumber = this.hubPoolClient.latestBlockNumber;
    try {
      this.hubPoolClient.getL1TokenCounterpartAtBlock(chainId, refundToken, hubPoolBlockNumber);
    } catch {
      return { valid: false, reason: `Refund token unknown at HubPool block ${hubPoolBlockNumber}` };
    }

    return { valid: true };
  }
}
