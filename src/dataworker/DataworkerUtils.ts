import { DepositWithBlock, FillWithBlock, UnfilledDeposit } from "../interfaces";
import { groupObjectCountsByProp, groupObjectCountsByTwoProps } from "../utils";
import { getDepositPath } from "./DepositUtils";
import { getFillsInRange } from "./FillUtils";

export function getBlockRangeForChain(
  blockRange: number[][],
  chain: number,
  chainIdListForBundleEvaluationBlockNumbers: number[]
): number[] {
  const indexForChain = chainIdListForBundleEvaluationBlockNumbers.indexOf(chain);
  if (indexForChain === -1)
    throw new Error(
      `Could not find chain ${chain} in chain ID list ${this.chainIdListForBundleEvaluationBlockNumbers}`
    );
  const blockRangeForChain = blockRange[indexForChain];
  if (!blockRangeForChain || blockRangeForChain.length !== 2) throw new Error(`Invalid block range for chain ${chain}`);
  return blockRangeForChain;
}

export function prettyPrintSpokePoolEvents(
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[],
  deposits: DepositWithBlock[],
  allValidFills: FillWithBlock[],
  allRelayerRefunds: { repaymentChain: string; repaymentToken: string }[],
  unfilledDeposits: UnfilledDeposit[],
  allInvalidFills: FillWithBlock[]
) {
  const allInvalidFillsInRange = getFillsInRange(
    allInvalidFills,
    blockRangesForChains,
    chainIdListForBundleEvaluationBlockNumbers
  );
  const allValidFillsInRange = getFillsInRange(
    allValidFills,
    blockRangesForChains,
    chainIdListForBundleEvaluationBlockNumbers
  );
  return {
    depositsInRangeByOriginChain: groupObjectCountsByTwoProps(deposits, "originChainId", (deposit) =>
      getDepositPath(deposit)
    ),
    allValidFillsInRangeByDestinationChain: groupObjectCountsByTwoProps(
      allValidFillsInRange,
      "destinationChainId",
      (fill) => `${fill.originChainId}-->${fill.destinationToken}`
    ),
    fillsToRefundInRangeByRepaymentChain: groupObjectCountsByTwoProps(
      allRelayerRefunds,
      "repaymentChain",
      (repayment) => repayment.repaymentToken
    ),
    unfilledDepositsByDestinationChain: groupObjectCountsByProp(
      unfilledDeposits,
      (unfilledDeposit) => unfilledDeposit.deposit.destinationChainId
    ),
    allValidFillsByDestinationChain: groupObjectCountsByProp(allValidFills, (fill) => fill.destinationChainId),
    allInvalidFillsInRangeByDestinationChain: groupObjectCountsByTwoProps(
      allInvalidFillsInRange,
      "destinationChainId",
      (fill) => `${fill.originChainId}-->${fill.destinationToken}`
    ),
  };
}
