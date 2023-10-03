import { Deposit, DepositWithBlock, Fill, UnfilledDeposit, UnfilledDepositsForOriginChain } from "../interfaces";
import { SpokePoolClient } from "../clients";
import { assign, toBN, isFirstFillForDeposit, getRedis } from "./";
import { getBlockRangeForChain } from "../dataworker/DataworkerUtils";
import { utils, typechain } from "@across-protocol/sdk-v2";
import { RedisCache } from "../caching/RedisCache";

export function getDepositPath(deposit: Deposit): string {
  return `${deposit.originToken}-->${deposit.destinationChainId}`;
}

export function updateUnfilledDepositsWithMatchedDeposit(
  matchedFill: Fill,
  matchedDeposit: Deposit,
  unfilledDepositsForOriginChain: UnfilledDepositsForOriginChain
): void {
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
): UnfilledDeposit[] {
  return (
    Object.values(unfilledDepositsForOriginChain)
      .map((_unfilledDeposits: UnfilledDeposit[]): UnfilledDeposit => {
        // Remove deposits with no matched fills.
        if (_unfilledDeposits.length === 0) {
          return { unfilledAmount: toBN(0), deposit: undefined };
        }
        // Remove deposits where there isn't a fill with fillAmount == totalFilledAmount && fillAmount > 0. This ensures
        // that we'll only be slow relaying deposits where the first fill (i.e. the one with
        // fillAmount == totalFilledAmount) is in this epoch. We assume that we already included slow fills in a
        // previous epoch for these ignored deposits.
        if (
          !_unfilledDeposits.some((_unfilledDeposit: UnfilledDeposit) => _unfilledDeposit.hasFirstPartialFill === true)
        ) {
          return { unfilledAmount: toBN(0), deposit: undefined };
        }
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
    .getDepositsForDestinationChain(destinationChain)
    .filter(
      (deposit: DepositWithBlock) =>
        deposit.blockNumber <= originChainBlockRange[1] &&
        deposit.blockNumber >= originChainBlockRange[0] &&
        !existingUniqueDeposits.some(
          (existingDeposit) =>
            existingDeposit.originChainId === deposit.originChainId && existingDeposit.depositId === deposit.depositId
        )
    ) as DepositWithBlock[];
}

export function getUniqueEarlyDepositsInRange(
  blockRangesForChains: number[][],
  originChain: number,
  destinationChain: number,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  originClient: SpokePoolClient,
  existingUniqueDeposits: typechain.FundsDepositedEvent[]
): typechain.FundsDepositedEvent[] {
  const originChainBlockRange = getBlockRangeForChain(
    blockRangesForChains,
    originChain,
    chainIdListForBundleEvaluationBlockNumbers
  );
  return (originClient["earlyDeposits"] as unknown as typechain.FundsDepositedEvent[]).filter(
    (deposit: typechain.FundsDepositedEvent) =>
      deposit.blockNumber <= originChainBlockRange[1] &&
      deposit.blockNumber >= originChainBlockRange[0] &&
      deposit.args.destinationChainId.toString() === destinationChain.toString() &&
      !existingUniqueDeposits.some(
        (existingDeposit) =>
          existingDeposit.args.originChainId.toString() === deposit.args.originChainId.toString() &&
          existingDeposit.args.depositId.toString() === deposit.args.depositId.toString()
      )
  );
}

export function isDepositSpedUp(deposit: Deposit): boolean {
  return deposit.speedUpSignature !== undefined && deposit.newRelayerFeePct !== undefined;
}

// Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
// This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
// of a deposit older or younger than its fixed lookback.
export async function queryHistoricalDepositForFill(
  spokePoolClient: SpokePoolClient,
  fill: Fill
): Promise<DepositWithBlock | undefined> {
  const cache = RedisCache.resolveFromRedisClient(await getRedis(spokePoolClient.logger), spokePoolClient.logger);
  return utils.queryHistoricalDepositForFill(spokePoolClient, fill, cache);
}
