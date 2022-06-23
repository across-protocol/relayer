import { HubPoolClient } from "../clients";
import { Deposit, Fill, FillsToRefund, FillWithBlock, SpokePoolClientsByChain } from "../interfaces";
import { BigNumber, assign, getRealizedLpFeeForFills, getRefundForFills, sortEventsDescending, toBN } from "./";
import { getBlockRangeForChain } from "../dataworker/DataworkerUtils";

export function getRefundInformationFromFill(
  fill: Fill,
  hubPoolClient: HubPoolClient,
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[]
) {
  // Handle slow relay where repaymentChainId = 0. Slow relays always pay recipient on destination chain.
  // So, save the slow fill under the destination chain, and save the fast fill under its repayment chain.
  const chainToSendRefundTo = fill.isSlowRelay ? fill.destinationChainId : fill.repaymentChainId;

  // Save fill data and associate with repayment chain and L2 token refund should be denominated in.
  const endBlockForMainnet = getBlockRangeForChain(
    blockRangesForChains,
    1,
    chainIdListForBundleEvaluationBlockNumbers
  )[1];
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    fill.destinationChainId.toString(),
    fill.destinationToken,
    endBlockForMainnet
  );
  const repaymentToken = hubPoolClient.getDestinationTokenForL1Token(l1TokenCounterpart, chainToSendRefundTo);
  return {
    chainToSendRefundTo,
    repaymentToken,
  };
}
export function assignValidFillToFillsToRefund(
  fillsToRefund: FillsToRefund,
  fill: Fill,
  chainToSendRefundTo: number,
  repaymentToken: string
) {
  assign(fillsToRefund, [chainToSendRefundTo, repaymentToken, "fills"], [fill]);
}

export function updateTotalRealizedLpFeePct(
  fillsToRefund: FillsToRefund,
  fill: Fill,
  chainToSendRefundTo: number,
  repaymentToken: string
) {
  const refundObj = fillsToRefund[chainToSendRefundTo][repaymentToken];
  refundObj.realizedLpFees = refundObj.realizedLpFees
    ? refundObj.realizedLpFees.add(getRealizedLpFeeForFills([fill]))
    : getRealizedLpFeeForFills([fill]);
}

export function updateTotalRefundAmount(
  fillsToRefund: FillsToRefund,
  fill: Fill,
  chainToSendRefundTo: number,
  repaymentToken: string
) {
  // Don't count slow relays in total refund amount, since we use this amount to conveniently construct
  // relayer refund leaves.
  if (fill.isSlowRelay) return;
  const refundObj = fillsToRefund[chainToSendRefundTo][repaymentToken];
  const refund = getRefundForFills([fill]);
  refundObj.totalRefundAmount = refundObj.totalRefundAmount ? refundObj.totalRefundAmount.add(refund) : refund;

  // Instantiate dictionary if it doesn't exist.
  if (!refundObj.refunds) assign(fillsToRefund, [chainToSendRefundTo, repaymentToken, "refunds"], {});

  if (refundObj.refunds[fill.relayer]) refundObj.refunds[fill.relayer] = refundObj.refunds[fill.relayer].add(refund);
  else refundObj.refunds[fill.relayer] = refund;
}

export function isFirstFillForDeposit(fill: Fill): boolean {
  return fill.fillAmount.eq(fill.totalFilledAmount) && fill.fillAmount.gt(toBN(0));
}

export function filledSameDeposit(fillA: Fill, fillB: Fill): boolean {
  return (
    fillA.depositId === fillB.depositId &&
    fillA.originChainId === fillB.originChainId &&
    fillA.amount.eq(fillB.amount) &&
    fillA.destinationChainId === fillB.destinationChainId &&
    fillA.relayerFeePct.eq(fillB.relayerFeePct) &&
    fillA.recipient === fillB.recipient &&
    fillA.depositor === fillB.depositor
  );
}

export function getLastMatchingFillBeforeBlock(
  fillToMatch: Fill,
  allFills: FillWithBlock[],
  lastBlock: number
): FillWithBlock {
  return sortEventsDescending(allFills).find(
    (fill: FillWithBlock) => !fill.isSlowRelay && lastBlock >= fill.blockNumber && filledSameDeposit(fillToMatch, fill)
  ) as FillWithBlock;
}

export function getFillDataForSlowFillFromPreviousRootBundle(
  latestMainnetBlock: number,
  fill: FillWithBlock,
  allValidFills: FillWithBlock[],
  hubPoolClient: HubPoolClient,
  chainIdListForBundleEvaluationBlockNumbers: number[]
) {
  // Find the first fill chronologically for matched deposit for the input fill.
  const firstFillForSameDeposit = allValidFills.find(
    (_fill: FillWithBlock) => isFirstFillForDeposit(_fill as Fill) && filledSameDeposit(_fill, fill)
  );

  // Find ending block number for chain from ProposeRootBundle event that should have included a slow fill
  // refund for this first fill. This will be undefined if there is no block range containing the first fill.
  const rootBundleEndBlockContainingFirstFill = hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
    latestMainnetBlock,
    firstFillForSameDeposit.blockNumber,
    firstFillForSameDeposit.destinationChainId,
    chainIdListForBundleEvaluationBlockNumbers
  );
  // Using bundle block number for chain from ProposeRootBundleEvent, find latest fill in the root bundle.
  let lastFillBeforeSlowFillIncludedInRoot;
  if (rootBundleEndBlockContainingFirstFill !== undefined) {
    lastFillBeforeSlowFillIncludedInRoot = getLastMatchingFillBeforeBlock(
      fill,
      allValidFills,
      rootBundleEndBlockContainingFirstFill
    );
  }
  return {
    lastFillBeforeSlowFillIncludedInRoot,
    rootBundleEndBlockContainingFirstFill,
  };
}

export function getFillsInRange(
  fills: FillWithBlock[],
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[]
) {
  return fills.filter((fill) => {
    const blockRangeForChain = getBlockRangeForChain(
      blockRangesForChains,
      fill.destinationChainId,
      chainIdListForBundleEvaluationBlockNumbers
    );
    return fill.blockNumber <= blockRangeForChain[1] && fill.blockNumber >= blockRangeForChain[0];
  });
}

// Returns all unfilled deposits over all spokePoolClients. Return values include the amount of the unfilled deposit.
export function getUnfilledDeposits(
  spokePoolClients: SpokePoolClientsByChain
): { deposit: Deposit; unfilledAmount: BigNumber; fillCount: number }[] {
  let unfilledDeposits: { deposit: Deposit; unfilledAmount: BigNumber; fillCount: number }[] = [];
  // Iterate over each chainId and check for unfilled deposits.
  const chainIds = Object.keys(spokePoolClients);
  for (const originChain of chainIds) {
    const originClient = spokePoolClients[originChain];
    for (const destinationChain of chainIds) {
      if (originChain === destinationChain) continue;
      // Find all unfilled deposits for the current loops originChain -> destinationChain. Note that this also
      // validates that the deposit is filled "correctly" for the given deposit information. This includes validation
      // of the all deposit -> relay props, the realizedLpFeePct and the origin->destination token mapping.
      const destinationClient = spokePoolClients[destinationChain];
      const depositsForDestinationChain = originClient.getDepositsForDestinationChain(destinationChain);
      const unfilledDepositsForDestinationChain = depositsForDestinationChain.map((deposit) => {
        return { ...destinationClient.getValidUnfilledAmountForDeposit(deposit), deposit };
      });
      // Remove any deposits that have no unfilled amount and append the remaining deposits to unfilledDeposits array.
      unfilledDeposits.push(...unfilledDepositsForDestinationChain.filter((deposit) => deposit.unfilledAmount.gt(0)));
    }
  }

  return unfilledDeposits;
}
