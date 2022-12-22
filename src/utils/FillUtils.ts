import { HubPoolClient } from "../clients";
import { DepositWithBlock, Fill, FillsToRefund, FillWithBlock, SpokePoolClientsByChain } from "../interfaces";
import { BigNumber, assign, getRealizedLpFeeForFills, getRefundForFills, sortEventsDescending, toBN } from "./";
import { getBlockRangeForChain } from "../dataworker/DataworkerUtils";
import _ from "lodash";

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
    (fill: FillWithBlock) => filledSameDeposit(fillToMatch, fill) && lastBlock >= fill.blockNumber
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
    (_fill: FillWithBlock) => filledSameDeposit(_fill, fill) && isFirstFillForDeposit(_fill as Fill)
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
  let lastMatchingFillInSameBundle;
  if (rootBundleEndBlockContainingFirstFill !== undefined) {
    lastMatchingFillInSameBundle = getLastMatchingFillBeforeBlock(
      fill,
      allValidFills,
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
  spokePoolClients: SpokePoolClientsByChain,
  maxUnfilledDepositLookBack: { [chainId: number]: number } = {}
): { deposit: DepositWithBlock; unfilledAmount: BigNumber; fillCount: number; invalidFills: Fill[] }[] {
  const unfilledDeposits: {
    deposit: DepositWithBlock;
    unfilledAmount: BigNumber;
    fillCount: number;
    invalidFills: Fill[];
  }[] = [];
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
      const depositsForDestinationChain: DepositWithBlock[] =
        originClient.getDepositsForDestinationChain(destinationChain);
      const unfilledDepositsForDestinationChain = depositsForDestinationChain
        .filter((deposit) => {
          // If deposit is older than unfilled deposit lookback, ignore it
          const lookback = maxUnfilledDepositLookBack[deposit.originChainId];
          const latestBlockForOriginChain = originClient.latestBlockNumber;
          return lookback === undefined || deposit.originBlockNumber >= latestBlockForOriginChain - lookback;
        })
        .map((deposit) => {
          // eslint-disable-next-line no-console
          return { ...destinationClient.getValidUnfilledAmountForDeposit(deposit), deposit };
        });
      // Remove any deposits that have no unfilled amount and append the remaining deposits to unfilledDeposits array.
      unfilledDeposits.push(...unfilledDepositsForDestinationChain.filter((deposit) => deposit.unfilledAmount.gt(0)));
    }
  }

  return unfilledDeposits;
}

// Returns set of block numbers, keyed by chain ID, that represent the highest block number for
// that chain where a fill event cannot possibly be matched with a deposit event on its origin chain.
// This dictionary can be used by the dataworker to conveniently skip root bundles whose start block is before
// the block returned by this function.

// How do we know if the set of `spokePoolClients` can validate a bundle block range:
// 1. The client lookbacks must include the bundle’s entire block range.
// 2. The earliest fill that we are unable to validate on each chain must be before the bundle’s start block.

// We use the above rules to return the latest blocks after which a bundle block range must start to be validatable.
export function getLatestInvalidBundleStartBlocks(spokePoolClients: SpokePoolClientsByChain): {
  [chainId: number]: number;
} {
  const blocks: { [chainId: number]: number } = {};
  for (const destChainId of Object.keys(spokePoolClients)) {
    const destSpokeClient = spokePoolClients[destChainId];

    // Default latest unmatched fill block to the spoke client's earliest queried block. This signals to the dataworker
    // not to attempt to validate any data earlier than its earliest queried block.
    blocks[destChainId] = destSpokeClient.eventSearchConfig.fromBlock;

    for (const originChainId of Object.keys(spokePoolClients)) {
      if (originChainId === destChainId) continue;

      // Search events from right to left in descending order to find first fill that can't possibly match with a
      // deposit in the spoke client. This is because deposit ID's are strictly increasing and cannot be forged since
      // they are emitted by the SpokePool contracts. This does mean that a malicious user can send a fill with a very
      // low deposit ID in order to crash the dataworker functions. This is why the dataworker dispute function
      // will emit an ERROR level log if it can't validate the pending bundle because the latestUnmatchedFill
      // block is manipulated too high.
      const latestUnmatchedFill = _.findLast(
        destSpokeClient.getFillsForOriginChain(Number(originChainId)),
        (fill) => fill.depositId < spokePoolClients[originChainId].earliestDepositId
      );
      if (latestUnmatchedFill !== undefined)
        blocks[destChainId] = Math.max(latestUnmatchedFill.blockNumber, blocks[destChainId]);
    }
  }
  return blocks;
}
