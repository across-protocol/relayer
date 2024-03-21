import assert from "assert";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { HubPoolClient, SpokePoolClient } from "../clients";
import {
  Fill,
  FillsToRefund,
  FillStatus,
  FillWithBlock,
  SpokePoolClientsByChain,
  V2DepositWithBlock,
  V2FillWithBlock,
  V3DepositWithBlock,
  V3FillWithBlock,
} from "../interfaces";
import { getBlockForTimestamp, getRedisCache, queryHistoricalDepositForFill } from "../utils";
import {
  BigNumber,
  bnZero,
  assign,
  getRealizedLpFeeForFills,
  getRefundForFills,
  isDefined,
  sortEventsDescending,
  sortEventsAscending,
} from "./";
import { getBlockRangeForChain } from "../dataworker/DataworkerUtils";

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
  const chainToSendRefundTo = sdkUtils.isSlowFill(fill) ? fill.destinationChainId : fill.repaymentChainId;

  // Save fill data and associate with repayment chain and L2 token refund should be denominated in.
  const endBlockForMainnet = getBlockRangeForChain(
    blockRangesForChains,
    hubPoolClient.chainId,
    chainIdListForBundleEvaluationBlockNumbers
  )[1];
  let l1TokenCounterpart: string;
  if (sdkUtils.isV3Fill(fill)) {
    l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
      fill.inputToken,
      fill.originChainId,
      endBlockForMainnet
    );
  } else {
    l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
      sdkUtils.getFillOutputToken(fill),
      fill.destinationChainId,
      endBlockForMainnet
    );
  }
  const repaymentToken = hubPoolClient.getL2TokenForL1TokenAtBlock(
    l1TokenCounterpart,
    chainToSendRefundTo,
    endBlockForMainnet
  );
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
  if (sdkUtils.isSlowFill(fill)) {
    return;
  }

  const refund = getRefundForFills([fill]);
  updateTotalRefundAmountRaw(fillsToRefund, refund, chainToSendRefundTo, fill.relayer, repaymentToken);
}

export function updateTotalRefundAmountRaw(
  fillsToRefund: FillsToRefund,
  amount: BigNumber,
  chainToSendRefundTo: number,
  recipient: string,
  repaymentToken: string
): void {
  if (!fillsToRefund?.[chainToSendRefundTo]?.[repaymentToken]) {
    assign(fillsToRefund, [chainToSendRefundTo, repaymentToken], {});
  }
  const refundObj = fillsToRefund[chainToSendRefundTo][repaymentToken];
  refundObj.totalRefundAmount = refundObj.totalRefundAmount ? refundObj.totalRefundAmount.add(amount) : amount;

  // Instantiate dictionary if it doesn't exist.
  if (!refundObj.refunds) {
    assign(fillsToRefund, [chainToSendRefundTo, repaymentToken, "refunds"], {});
  }

  if (refundObj.refunds[recipient]) {
    refundObj.refunds[recipient] = refundObj.refunds[recipient].add(amount);
  } else {
    refundObj.refunds[recipient] = amount;
  }
}

export function isFirstFillForDeposit(fill: Fill): boolean {
  if (sdkUtils.isV3Fill(fill)) {
    return true;
  }

  const fillAmount = sdkUtils.getFillAmount(fill);
  const totalFilledAmount = sdkUtils.getTotalFilledAmount(fill);
  return fillAmount.eq(totalFilledAmount) && fillAmount.gt(bnZero);
}

export function getLastMatchingFillBeforeBlock(
  fillToMatch: Fill,
  allFills: FillWithBlock[],
  lastBlock: number
): FillWithBlock {
  return sortEventsDescending(allFills).find(
    (fill: FillWithBlock) => sdkUtils.filledSameDeposit(fillToMatch, fill) && lastBlock >= fill.blockNumber
  ) as FillWithBlock;
}

export async function getFillDataForSlowFillFromPreviousRootBundle(
  latestMainnetBlock: number,
  fill: V2FillWithBlock,
  allValidFills: V2FillWithBlock[],
  hubPoolClient: HubPoolClient,
  spokePoolClientsByChain: SpokePoolClientsByChain
): Promise<{
  lastMatchingFillInSameBundle: FillWithBlock;
  rootBundleEndBlockContainingFirstFill: number;
}> {
  assert(sdkUtils.isV2Fill(fill));
  assert(allValidFills.every(sdkUtils.isV2Fill));

  // Can use spokeClient.queryFillsForDeposit(_fill, spokePoolClient.eventSearchConfig.fromBlock)
  // if allValidFills doesn't contain the deposit's first fill to efficiently find the first fill for a deposit.
  // Note that allValidFills should only include fills later than than eventSearchConfig.fromBlock.

  // Find the first fill chronologically for matched deposit for the input fill.
  const allMatchingFills = sortEventsAscending(
    allValidFills.filter((_fill) => _fill.depositId === fill.depositId && sdkUtils.filledSameDeposit(_fill, fill))
  );
  let firstFillForSameDeposit = allMatchingFills.find((_fill) => isFirstFillForDeposit(_fill));

  // If `allValidFills` doesn't contain the first fill for this deposit then we have to perform a historical query to
  // find it. This is inefficient, but should be rare. Save any other fills we find to the
  // allMatchingFills array, at the end of this block, allMatchingFills should contain all fills for the same
  // deposit as the input fill.
  if (!firstFillForSameDeposit) {
    const depositForFill = await queryHistoricalDepositForFill(spokePoolClientsByChain[fill.originChainId], fill);
    assert(depositForFill.found && sdkUtils.isV2Deposit(depositForFill.deposit));
    const matchingFills = (
      await spokePoolClientsByChain[fill.destinationChainId].queryHistoricalMatchingFills(
        fill,
        depositForFill.found ? depositForFill.deposit : undefined,
        allMatchingFills[0].blockNumber
      )
    ).filter(sdkUtils.isV2Fill<V2FillWithBlock, V3FillWithBlock>);

    spokePoolClientsByChain[fill.destinationChainId].logger.debug({
      at: "FillUtils#getFillDataForSlowFillFromPreviousRootBundle",
      message: "Queried for partial fill that triggered an unused slow fill, in order to compute slow fill excess",
      fillThatCompletedDeposit: fill,
      depositForFill,
      matchingFills,
    });

    firstFillForSameDeposit = sortEventsAscending(matchingFills).find((_fill) => isFirstFillForDeposit(_fill));
    if (firstFillForSameDeposit === undefined) {
      throw new Error(
        "FillUtils#getFillDataForSlowFillFromPreviousRootBundle:" +
          ` Cannot find first fill for for deposit ${fill.depositId}` +
          ` on chain ${fill.destinationChainId} after querying historical fills`
      );
    }
    // Add non-duplicate fills.
    allMatchingFills.push(
      ...matchingFills.filter((_fill) => {
        const totalFilledAmount = sdkUtils.getTotalFilledAmount(_fill);
        return !allMatchingFills.find((existingFill) =>
          sdkUtils.getTotalFilledAmount(existingFill).eq(totalFilledAmount)
        );
      })
    );
  }

  // Find ending block number for chain from ProposeRootBundle event that should have included a slow fill
  // refund for this first fill. This will be undefined if there is no block range containing the first fill.
  const rootBundleEndBlockContainingFirstFill = hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
    latestMainnetBlock,
    firstFillForSameDeposit.blockNumber,
    firstFillForSameDeposit.destinationChainId
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
  fills: V2FillWithBlock[],
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[]
): V2FillWithBlock[] {
  const blockRanges = Object.fromEntries(
    chainIdListForBundleEvaluationBlockNumbers.map((chainId) => [
      chainId,
      getBlockRangeForChain(blockRangesForChains, chainId, chainIdListForBundleEvaluationBlockNumbers),
    ])
  );
  return fills.filter((fill) => {
    const [startBlock, endBlock] = blockRanges[fill.destinationChainId];
    return fill.blockNumber >= startBlock && fill.blockNumber <= endBlock;
  });
}

// @dev This type can be confused with UnfilledDeposit from sdk-v2/interfaces, but is different
//      due to the additional members and the use of DepositWithBlock instead of Deposit.
// @todo Better alignment with the upstream UnfilledDeposit type.
export type RelayerUnfilledDeposit = {
  deposit: V3DepositWithBlock;
  fillStatus: number;
  version: number;
  invalidFills: Fill[];
};

// @description Returns all unfilled deposits, indexed by destination chain.
// @param spokePoolClients  Mapping of chainIds to SpokePoolClient objects.
// @param configStoreClient ConfigStoreClient instance.
// @param depositLookBack   Deposit lookback (in seconds) since SpokePoolClient time as at last update.
// @returns Array of unfilled deposits.
export async function getUnfilledDeposits(
  spokePoolClients: SpokePoolClientsByChain,
  hubPoolClient: HubPoolClient,
  depositLookBack?: number
): Promise<{ [chainId: number]: RelayerUnfilledDeposit[] }> {
  const unfilledDeposits: { [chainId: number]: RelayerUnfilledDeposit[] } = {};
  const chainIds = Object.values(spokePoolClients).map(({ chainId }) => chainId);
  const originFromBlocks: { [chainId: number]: number } = Object.fromEntries(
    Object.values(spokePoolClients).map(({ chainId, deploymentBlock }) => [chainId, deploymentBlock])
  );

  if (isDefined(depositLookBack)) {
    const blockFinder = undefined;
    const redis = await getRedisCache();
    await sdkUtils.forEachAsync(Object.values(spokePoolClients), async (spokePoolClient: SpokePoolClient) => {
      const { chainId: originChainId, deploymentBlock } = spokePoolClient;
      const timestamp = spokePoolClient.getCurrentTime() - depositLookBack;
      const hints = { lowBlock: deploymentBlock };
      const startBlock = await getBlockForTimestamp(originChainId, timestamp, blockFinder, redis, hints);
      originFromBlocks[originChainId] = Math.max(deploymentBlock, startBlock);
    });
  }

  // Iterate over each chainId and check for unfilled deposits.
  await sdkUtils.mapAsync(chainIds, async (destinationChainId) => {
    const destinationClient = spokePoolClients[destinationChainId];

    // For each destination chain, query each _other_ SpokePool for deposits within the lookback.
    const deposits = chainIds
      .filter((chainId) => chainId !== destinationChainId)
      .map((originChainId) => {
        const originClient = spokePoolClients[originChainId];
        const earliestBlockNumber = originFromBlocks[originChainId];
        const { deploymentBlock, latestBlockSearched } = originClient;

        // Basic sanity check...
        assert(earliestBlockNumber >= deploymentBlock && earliestBlockNumber <= latestBlockSearched);

        // Find all unfilled deposits for the current loops originChain -> destinationChain.
        return originClient
          .getDepositsForDestinationChain(destinationChainId)
          .filter((deposit) => deposit.blockNumber >= earliestBlockNumber)
          .filter(sdkUtils.isV3Deposit<V3DepositWithBlock, V2DepositWithBlock>); // @todo: Remove after v2 deprecated.
      })
      .flat();

    // Resolve the latest fill status for each deposit and filter out any that are now filled.
    const { spokePool } = destinationClient;
    const fillStatus = await sdkUtils.fillStatusArray(spokePool, deposits);
    unfilledDeposits[destinationChainId] = deposits
      .map((deposit, idx) => ({ deposit, fillStatus: fillStatus[idx] }))
      .filter((_, idx) => fillStatus[idx] !== FillStatus.Filled)
      .map(({ deposit, fillStatus }) => {
        const version = hubPoolClient.configStoreClient.getConfigStoreVersionForTimestamp(deposit.quoteTimestamp);
        const { invalidFills } = destinationClient.getValidUnfilledAmountForDeposit(deposit);
        return { deposit, version, fillStatus, invalidFills };
      });
  });

  return unfilledDeposits;
}
