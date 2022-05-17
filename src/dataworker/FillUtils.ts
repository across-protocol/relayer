import { HubPoolClient } from "../clients";
import { Fill, FillsToRefund, FillWithBlock } from "../interfaces";
import { assign, getRealizedLpFeeForFills, getRefundForFills, sortEventsDescending, toBN } from "../utils";
import { getBlockRangeForChain } from "./DataworkerUtils";

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
  const repaymentToken = hubPoolClient.getDestinationTokenForL1TokenDestinationChainId(
    l1TokenCounterpart,
    chainToSendRefundTo
  );
  return {
    chainToSendRefundTo,
    repaymentToken,
  };
}
export function updateFillsToRefundWithValidFill(
  fillsToRefund: FillsToRefund,
  fill: Fill,
  chainToSendRefundTo: number,
  repaymentToken: string
) {
  assign(fillsToRefund, [chainToSendRefundTo, repaymentToken, "fills"], [fill]);

  // Update realized LP fee accumulator for slow and non-slow fills.
  const refundObj = fillsToRefund[chainToSendRefundTo][repaymentToken];
  refundObj.realizedLpFees = refundObj.realizedLpFees
    ? refundObj.realizedLpFees.add(getRealizedLpFeeForFills([fill]))
    : getRealizedLpFeeForFills([fill]);
}

export function updateFillsToRefundWithSlowFill(
  fillsToRefund: FillsToRefund,
  fill: Fill,
  chainToSendRefundTo: number,
  repaymentToken: string
) {
  const refundObj = fillsToRefund[chainToSendRefundTo][repaymentToken];
  // Update total refund amount for non-slow fills, since refunds for executed slow fills would have been
  // included in a previous root bundle.
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
    fillA.amount.eq(fillB.amount) &&
    fillA.originChainId === fillB.originChainId &&
    fillA.destinationChainId === fillB.destinationChainId &&
    fillA.relayerFeePct.eq(fillB.relayerFeePct) &&
    fillA.depositId === fillB.depositId &&
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
  fill: FillWithBlock,
  allValidFills: FillWithBlock[],
  hubPoolClient: HubPoolClient,
  chainIdListForBundleEvaluationBlockNumbers: number[]
) {
  // Find the first fill chronologically for matched deposit for the input fill.
  const firstFillForSameDeposit = allValidFills.find(
    (_fill: FillWithBlock) => isFirstFillForDeposit(_fill as Fill) && filledSameDeposit(_fill, fill)
  );
  if (firstFillForSameDeposit === undefined) {
    // If there is no first fill associated with a slow fill, then something is wrong because we assume that slow
    // fills can only be sent after at least one non-zero partial fill is submitted for a deposit.
    if (fill.isSlowRelay) throw new Error("Can't find earliest fill associated with slow fill");
    // If there is no first fill associated with the current partial fill, then it must be the first fill and we'll
    // skip it because there are running balance adjustments to make for this type of fill.
    else return;
  }
  // Find ending block number for chain from ProposeRootBundle event that should have included a slow fill
  // refund for this first fill. This will be undefined if there is no block range containing the first fill.
  const rootBundleEndBlockContainingFirstFill = hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
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

export function getFillCountGroupedByProp(fills: FillWithBlock[], propName: string) {
  return fills.reduce((result, fill: FillWithBlock) => {
    const existingCount = result[fill[propName]];
    result[fill[propName]] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}

export function getFillCountGroupedByToken(fills: FillWithBlock[]) {
  return fills.reduce((result, fill: FillWithBlock) => {
    result[fill.destinationChainId] = result[fill.destinationChainId] ?? {};
    const fillPath = `${fill.originChainId}-->${fill.destinationToken}`;
    const existingCount = result[fill.destinationChainId][fillPath];
    result[fill.destinationChainId][fillPath] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}

export function getFillsToRefundCountGroupedByRepaymentChain(fills: FillsToRefund) {
  return Object.keys(fills).reduce((endResult, repaymentChain) => {
    endResult[repaymentChain] = endResult[repaymentChain] ?? {};
    return Object.keys(fills[repaymentChain]).reduce((result, repaymentToken) => {
      const existingCount = result[repaymentChain][repaymentToken];
      const fillCount = fills[repaymentChain][repaymentToken].fills.length;
      result[repaymentChain][repaymentToken] = existingCount === undefined ? fillCount : existingCount + fillCount;
      return result;
    }, endResult);
  }, {});
}
