import { SpokePoolClient } from "../clients";
import { Deposit, DepositWithBlock, Fill, UnfilledDeposit, UnfilledDepositsForOriginChain } from "../interfaces";
import { assign, toBN } from "../utils";
import { getBlockRangeForChain } from "./DataworkerUtils";
import { isFirstFillForDeposit } from "./FillUtils";

export function getDepositCountGroupedByToken(deposits: DepositWithBlock[]) {
  return deposits.reduce((result, deposit: DepositWithBlock) => {
    result[deposit.originChainId] = result[deposit.originChainId] ?? {};
    const existingCount = result[deposit.originChainId][deposit.originToken];
    result[deposit.originChainId][deposit.originToken] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}

export function getUnfilledDepositCountGroupedByProp(unfilledDeposits: UnfilledDeposit[], propName: string) {
  return unfilledDeposits.reduce((result, unfilledDeposit: UnfilledDeposit) => {
    const existingCount = result[unfilledDeposit.deposit[propName]];
    result[unfilledDeposit.deposit[propName]] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}

export function updateUnfilledDepositsWithMatchedDeposit(
  matchedFill: Fill,
  matchedDeposit: Deposit,
  unfilledDepositsForOriginChain: UnfilledDepositsForOriginChain
) {
  const depositUnfilledAmount = matchedFill.amount.sub(matchedFill.totalFilledAmount);
  const depositKey = `${matchedDeposit.originChainId}+${matchedFill.depositId}`;
  assign(
    unfilledDepositsForOriginChain,
    [depositKey],
    [
      {
        unfilledAmount: depositUnfilledAmount,
        deposit: matchedDeposit,
        // A first partial fill for a deposit is characterized by one whose total filled amount post-fill
        // is equal to the amount sent in the fill, and where the fill amount is greater than zero.
        hasFirstPartialFill: isFirstFillForDeposit(matchedFill),
      },
    ]
  );
}

export function flattenAndFilterUnfilledDepositsByOriginChain(
  unfilledDepositsForOriginChain: UnfilledDepositsForOriginChain
) {
  return (
    Object.values(unfilledDepositsForOriginChain)
      .map((_unfilledDeposits: UnfilledDeposit[]): UnfilledDeposit => {
        // Remove deposits with no matched fills.
        if (_unfilledDeposits.length === 0) return { unfilledAmount: toBN(0), deposit: undefined };
        // Remove deposits where there isn't a fill with fillAmount == totalFilledAmount && fillAmount > 0. This ensures
        // that we'll only be slow relaying deposits where the first fill (i.e. the one with
        // fillAmount == totalFilledAmount) is in this epoch. We assume that we already included slow fills in a
        // previous epoch for these ignored deposits.
        if (
          !_unfilledDeposits.some((_unfilledDeposit: UnfilledDeposit) => _unfilledDeposit.hasFirstPartialFill === true)
        )
          return { unfilledAmount: toBN(0), deposit: undefined };
        // For each deposit, identify the smallest unfilled amount remaining after a fill since each fill can
        // only decrease the unfilled amount.
        _unfilledDeposits.sort((unfilledDepositA, unfilledDepositB) =>
          unfilledDepositA.unfilledAmount.gt(unfilledDepositB.unfilledAmount)
            ? 1
            : unfilledDepositA.unfilledAmount.lt(unfilledDepositB.unfilledAmount)
            ? -1
            : 0
        );
        return { unfilledAmount: _unfilledDeposits[0].unfilledAmount, deposit: _unfilledDeposits[0].deposit };
      })
      // Remove deposits that are fully filled
      .filter((unfilledDeposit: UnfilledDeposit) => unfilledDeposit.unfilledAmount.gt(0))
  );
}

export function getUniqueDepositsInRange(
  blockRangesForChains: number[][],
  originChain: number,
  destinationChain: number,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  originClient: SpokePoolClient,
  existingUniqueDeposits: DepositWithBlock[]
): DepositWithBlock[] {
  const originChainBlockRange = getBlockRangeForChain(
    blockRangesForChains,
    originChain,
    chainIdListForBundleEvaluationBlockNumbers
  );
  return originClient
    .getDepositsForDestinationChain(destinationChain, true)
    .filter(
      (deposit: DepositWithBlock) =>
        deposit.originBlockNumber <= originChainBlockRange[1] &&
        deposit.originBlockNumber >= originChainBlockRange[0] &&
        !existingUniqueDeposits.some(
          (existingDeposit) =>
            existingDeposit.originChainId === deposit.originChainId && existingDeposit.depositId === deposit.depositId
        )
    ) as DepositWithBlock[];
}
