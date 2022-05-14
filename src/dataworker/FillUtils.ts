import { HubPoolClient } from "../clients";
import { Fill, FillsToRefund, FillWithBlock } from "../interfaces";
import { sortEventsDescending, toBN } from "../utils";
import { getBlockRangeForChain } from "./DataworkerUtils";

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

export function getFillsToRefundCountGroupedByProp(fills: FillsToRefund, propName: string) {
  return Object.keys(fills).reduce((endResult, repaymentChain) => {
    endResult[propName] = endResult[propName] ?? {};
    return Object.keys(fills[repaymentChain]).reduce((result, repaymentToken) => {
      const existingCount = result[propName][repaymentToken];
      const fillCount = fills[repaymentChain][repaymentToken].fills.length;
      result[propName][repaymentToken] = existingCount === undefined ? fillCount : existingCount + fillCount;
      return result;
    }, endResult);
  }, {});
}
