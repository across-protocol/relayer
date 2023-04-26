import { AcrossConfigStoreClient, HubPoolClient } from "../clients";
import { Deposit, DepositWithBlock, Fill, FillsToRefund, FillWithBlock, SpokePoolClientsByChain } from "../interfaces";
import {
  BigNumber,
  assign,
  getRealizedLpFeeForFills,
  getRefundForFills,
  sortEventsDescending,
  toBN,
  sortEventsAscending,
} from "./";
import { getBlockRangeForChain } from "../dataworker/DataworkerUtils";

const FILL_DEPOSIT_COMPARISON_KEYS = [
  "amount",
  "originChainId",
  "relayerFeePct",
  "realizedLpFeePct",
  "depositId",
  "depositor",
  "recipient",
  "destinationChainId",
  "destinationToken",
] as const;

export function getRefundInformationFromFill(
  fill: Fill,
  hubPoolClient: HubPoolClient,
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[]
): {
  chainToSendRefundTo: number;
  repaymentToken: string;
} {
  // Handle slow relay where repaymentChainId = 0. Slow relays always pay recipient on destination chain.
  // So, save the slow fill under the destination chain, and save the fast fill under its repayment chain.
  const chainToSendRefundTo = fill.updatableRelayData.isSlowRelay ? fill.destinationChainId : fill.repaymentChainId;

  // Save fill data and associate with repayment chain and L2 token refund should be denominated in.
  const endBlockForMainnet = getBlockRangeForChain(
    blockRangesForChains,
    1,
    chainIdListForBundleEvaluationBlockNumbers
  )[1];
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    fill.destinationChainId,
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
): void {
  assign(fillsToRefund, [chainToSendRefundTo, repaymentToken, "fills"], [fill]);
}

export function updateTotalRealizedLpFeePct(
  fillsToRefund: FillsToRefund,
  fill: Fill,
  chainToSendRefundTo: number,
  repaymentToken: string
): void {
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
): void {
  // Don't count slow relays in total refund amount, since we use this amount to conveniently construct
  // relayer refund leaves.
  if (fill.updatableRelayData.isSlowRelay) {
    return;
  }
  const refundObj = fillsToRefund[chainToSendRefundTo][repaymentToken];
  const refund = getRefundForFills([fill]);
  refundObj.totalRefundAmount = refundObj.totalRefundAmount ? refundObj.totalRefundAmount.add(refund) : refund;

  // Instantiate dictionary if it doesn't exist.
  if (!refundObj.refunds) {
    assign(fillsToRefund, [chainToSendRefundTo, repaymentToken, "refunds"], {});
  }

  if (refundObj.refunds[fill.relayer]) {
    refundObj.refunds[fill.relayer] = refundObj.refunds[fill.relayer].add(refund);
  } else {
    refundObj.refunds[fill.relayer] = refund;
  }
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
    (fill: FillWithBlock) => filledSameDeposit(fillToMatch, fill) && lastBlock >= fill.blockNumber
  ) as FillWithBlock;
}

export async function getFillDataForSlowFillFromPreviousRootBundle(
  latestMainnetBlock: number,
  fill: FillWithBlock,
  allValidFills: FillWithBlock[],
  hubPoolClient: HubPoolClient,
  spokePoolClientsByChain: SpokePoolClientsByChain,
  chainIdListForBundleEvaluationBlockNumbers: number[]
): Promise<{
  lastMatchingFillInSameBundle: FillWithBlock;
  rootBundleEndBlockContainingFirstFill: number;
}> {
  // Can use spokeClient.queryFillsForDeposit(_fill, spokePoolClient.eventSearchConfig.fromBlock)
  // if allValidFills doesn't contain the deposit's first fill to efficiently find the first fill for a deposit.
  // Note that allValidFills should only include fills later than than eventSearchConfig.fromBlock.

  // Find the first fill chronologically for matched deposit for the input fill.
  const allMatchingFills = sortEventsAscending(
    allValidFills.filter((_fill: FillWithBlock) => filledSameDeposit(_fill, fill))
  );
  let firstFillForSameDeposit = allMatchingFills.find((_fill) => isFirstFillForDeposit(_fill));

  // If `allValidFills` doesn't contain the first fill for this deposit then we have to perform a historical query to
  // find it. This is inefficient, but should be rare. Save any other fills we find to the
  // allMatchingFills array, at the end of this block, allMatchingFills should contain all fills for the same
  // deposit as the input fill.
  if (!firstFillForSameDeposit) {
    const depositForFill = await spokePoolClientsByChain[fill.originChainId].queryHistoricalDepositForFill(fill);
    const matchingFills = await spokePoolClientsByChain[fill.destinationChainId].queryHistoricalMatchingFills(
      fill,
      depositForFill,
      allMatchingFills[0].blockNumber
    );
    spokePoolClientsByChain[fill.destinationChainId].logger.debug({
      at: "FillUtils#getFillDataForSlowFillFromPreviousRootBundle",
      message:
        "Queried for fill that triggered a slow fill for a deposit that was fully filled, in order to compute slow fill excess",
      fillThatCompletedDeposit: fill,
      depositForFill,
      matchingFills,
    });
    firstFillForSameDeposit = sortEventsAscending(matchingFills).find((_fill) => isFirstFillForDeposit(_fill));
    if (firstFillForSameDeposit === undefined) {
      throw new Error(
        `FillUtils#getFillDataForSlowFillFromPreviousRootBundle: Cannot find first fill for for deposit ${fill.depositId} on chain ${fill.destinationChainId} after querying historical fills`
      );
    }
    // Add non-duplicate fills.
    allMatchingFills.push(
      ...matchingFills.filter(
        (_fill) => !allMatchingFills.find((existingFill) => existingFill.totalFilledAmount.eq(_fill.totalFilledAmount))
      )
    );
  }

  // Find ending block number for chain from ProposeRootBundle event that should have included a slow fill
  // refund for this first fill. This will be undefined if there is no block range containing the first fill.
  const rootBundleEndBlockContainingFirstFill = hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
    latestMainnetBlock,
    firstFillForSameDeposit.blockNumber,
    firstFillForSameDeposit.destinationChainId,
    chainIdListForBundleEvaluationBlockNumbers
  );
  // Using bundle block number for chain from ProposeRootBundleEvent, find latest fill in the root bundle.
  let lastMatchingFillInSameBundle: FillWithBlock;
  if (rootBundleEndBlockContainingFirstFill !== undefined) {
    lastMatchingFillInSameBundle = getLastMatchingFillBeforeBlock(
      fill,
      sortEventsDescending(allMatchingFills),
      rootBundleEndBlockContainingFirstFill
    );
  }
  return {
    lastMatchingFillInSameBundle,
    rootBundleEndBlockContainingFirstFill,
  };
}

export function getFillsInRange(
  fills: FillWithBlock[],
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[]
): FillWithBlock[] {
  return fills.filter((fill) => {
    const blockRangeForChain = getBlockRangeForChain(
      blockRangesForChains,
      fill.destinationChainId,
      chainIdListForBundleEvaluationBlockNumbers
    );
    return fill.blockNumber <= blockRangeForChain[1] && fill.blockNumber >= blockRangeForChain[0];
  });
}

export type UnfilledDeposit = {
  deposit: DepositWithBlock;
  unfilledAmount: BigNumber;
  fillCount: number;
  invalidFills: Fill[];
  requiresNewConfigStoreVersion: boolean;
};
// Returns all unfilled deposits over all spokePoolClients. Return values include the amount of the unfilled deposit.
export function getUnfilledDeposits(
  spokePoolClients: SpokePoolClientsByChain,
  maxUnfilledDepositLookBack: number,
  configStoreClient: AcrossConfigStoreClient
): UnfilledDeposit[] {
  const unfilledDeposits: UnfilledDeposit[] = [];
  // Iterate over each chainId and check for unfilled deposits.
  const chainIds = Object.keys(spokePoolClients);
  for (const originChain of chainIds) {
    const originClient = spokePoolClients[originChain];
    for (const destinationChain of chainIds) {
      if (originChain === destinationChain) {
        continue;
      }
      // Find all unfilled deposits for the current loops originChain -> destinationChain. Note that this also
      // validates that the deposit is filled "correctly" for the given deposit information. This includes validation
      // of the all deposit -> relay props, the realizedLpFeePct and the origin->destination token mapping.
      const destinationClient = spokePoolClients[destinationChain];
      const depositsForDestinationChain: DepositWithBlock[] =
        originClient.getDepositsForDestinationChain(destinationChain);
      const unfilledDepositsForDestinationChain = depositsForDestinationChain
        .filter((deposit) => {
          // If deposit is older than unfilled deposit lookback, ignore it
          const latestBlockForOriginChain = originClient.latestBlockNumber;
          return deposit.blockNumber >= latestBlockForOriginChain - maxUnfilledDepositLookBack;
        })
        .map((deposit) => {
          // eslint-disable-next-line no-console
          return { ...destinationClient.getValidUnfilledAmountForDeposit(deposit), deposit };
        });
      // Remove any deposits that have no unfilled amount and append the remaining deposits to unfilledDeposits array.
      unfilledDeposits.push(...unfilledDepositsForDestinationChain.filter((deposit) => deposit.unfilledAmount.gt(0)));
    }
  }

  // If the config store version is up to date, then we can return the unfilled deposits as is. Otherwise, we need to
  // make sure we have a high enough version for each deposit.
  if (configStoreClient.hasLatestConfigStoreVersion) {
    return unfilledDeposits;
  } else {
    return unfilledDeposits.map((unfilledDeposit) => {
      return {
        ...unfilledDeposit,
        requiresNewConfigStoreVersion: !configStoreClient.hasValidConfigStoreVersionForTimestamp(
          unfilledDeposit.deposit.quoteTimestamp
        ),
      };
    });
  }
}

// Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
// by the depositor as well as the realizedLpFeePct and the destinationToken, which are pulled from other clients.
export function validateFillForDeposit(fill: Fill, deposit?: Deposit): boolean {
  if (deposit === undefined) {
    return false;
  }

  // Note: this short circuits when a key is found where the comparison doesn't match.
  // TODO: if we turn on "strict" in the tsconfig, the elements of FILL_DEPOSIT_COMPARISON_KEYS will be automatically
  // validated against the fields in Fill and Deposit, generating an error if there is a discrepency.
  return FILL_DEPOSIT_COMPARISON_KEYS.every((key) => {
    return fill[key] !== undefined && fill[key].toString() === deposit[key]?.toString();
  });
}
