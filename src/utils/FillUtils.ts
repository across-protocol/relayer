import assert from "assert";
import { clients, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { HubPoolClient } from "../clients";
import {
  DepositWithBlock,
  Fill,
  FillsToRefund,
  FillWithBlock,
  v2FillWithBlock,
  SpokePoolClientsByChain,
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
import { UBA_MIN_CONFIG_STORE_VERSION } from "../common";

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
  // @todo In v3, destination... must be swapped for origin...
  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    sdkUtils.getFillOutputToken(fill),
    fill.destinationChainId,
    endBlockForMainnet
  );
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
  fill: v2FillWithBlock,
  allValidFills: v2FillWithBlock[],
  hubPoolClient: HubPoolClient,
  spokePoolClientsByChain: SpokePoolClientsByChain
): Promise<{
  lastMatchingFillInSameBundle: FillWithBlock;
  rootBundleEndBlockContainingFirstFill: number;
}> {
  assert(sdkUtils.isV2Fill(fill));

  // Can use spokeClient.queryFillsForDeposit(_fill, spokePoolClient.eventSearchConfig.fromBlock)
  // if allValidFills doesn't contain the deposit's first fill to efficiently find the first fill for a deposit.
  // Note that allValidFills should only include fills later than than eventSearchConfig.fromBlock.

  // Find the first fill chronologically for matched deposit for the input fill.
  const allMatchingFills = sortEventsAscending(
    allValidFills.filter((_fill: FillWithBlock) => sdkUtils.isV2Fill(_fill) && sdkUtils.filledSameDeposit(_fill, fill))
  );
  let firstFillForSameDeposit = allMatchingFills.find((_fill) => isFirstFillForDeposit(_fill));

  // If `allValidFills` doesn't contain the first fill for this deposit then we have to perform a historical query to
  // find it. This is inefficient, but should be rare. Save any other fills we find to the
  // allMatchingFills array, at the end of this block, allMatchingFills should contain all fills for the same
  // deposit as the input fill.
  if (!firstFillForSameDeposit) {
    const depositForFill = await queryHistoricalDepositForFill(spokePoolClientsByChain[fill.originChainId], fill);
    const matchingFills = (
      await spokePoolClientsByChain[fill.destinationChainId].queryHistoricalMatchingFills(
        fill,
        depositForFill.found ? depositForFill.deposit : undefined,
        allMatchingFills[0].blockNumber
      )
    ).filter(sdkUtils.isV2Fill) as v2FillWithBlock[];

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

// @dev This type can be confused with UnfilledDeposit from sdk-v2/interfaces, but is different
//      due to the additional members and the use of DepositWithBlock instead of Deposit.
// @todo Better alignment with the upstream UnfilledDeposit type.
export type RelayerUnfilledDeposit = {
  deposit: DepositWithBlock;
  version: number;
  unfilledAmount: BigNumber;
  fillCount: number;
  invalidFills: Fill[];
};

// @description Returns an array of unfilled deposits over all spokePoolClients.
// @param spokePoolClients  Mapping of chainIds to SpokePoolClient objects.
// @param configStoreClient ConfigStoreClient instance.
// @param depositLookBack   Deposit lookback (in seconds) since SpokePoolClient time as at last update.
// @returns Array of unfilled deposits.
export async function getUnfilledDeposits(
  spokePoolClients: SpokePoolClientsByChain,
  hubPoolClient: HubPoolClient,
  depositLookBack?: number
): Promise<RelayerUnfilledDeposit[]> {
  const unfilledDeposits: RelayerUnfilledDeposit[] = [];
  const chainIds = Object.values(spokePoolClients).map(({ chainId }) => chainId);
  let earliestBlockNumbers = Object.values(spokePoolClients).map(({ deploymentBlock }) => deploymentBlock);

  if (isDefined(depositLookBack)) {
    const blockFinder = undefined;
    const redis = await getRedisCache();
    earliestBlockNumbers = await Promise.all(
      Object.values(spokePoolClients).map((spokePoolClient) => {
        const timestamp = spokePoolClient.getCurrentTime() - depositLookBack;
        const hints = { lowBlock: spokePoolClient.deploymentBlock };
        return getBlockForTimestamp(spokePoolClient.chainId, timestamp, blockFinder, redis, hints);
      })
    );
  }

  // Iterate over each chainId and check for unfilled deposits.
  for (const originClient of Object.values(spokePoolClients)) {
    const { chainId: originChainId } = originClient;
    const chainIdx = chainIds.indexOf(originChainId);
    assert(chainIdx !== -1, `Invalid chain index for chainId ${originChainId} (${chainIdx})`);
    const earliestBlockNumber = earliestBlockNumbers[chainIdx];

    for (const destinationChain of chainIds.filter((chainId) => chainId !== originChainId)) {
      // Find all unfilled deposits for the current loops originChain -> destinationChain. Note that this also
      // validates that the deposit is filled "correctly" for the given deposit information. This includes validation
      // of the all deposit -> relay props, the realizedLpFeePct and the origin->destination token mapping.
      const destinationClient = spokePoolClients[destinationChain];
      const depositsForDestinationChain: DepositWithBlock[] =
        originClient.getDepositsForDestinationChain(destinationChain);

      const unfilledDepositsForDestinationChain = depositsForDestinationChain
        .filter((deposit) => deposit.blockNumber >= earliestBlockNumber)
        .map((deposit) => {
          let version: number;
          // To determine if the fill is a UBA fill, we need to check against the UBA bundle start blocks.
          if (clients.isUBAActivatedAtBlock(hubPoolClient, deposit.blockNumber, deposit.originChainId)) {
            // Use latest deposit block now to grab version which should be above the UBA activation version.
            version = hubPoolClient.configStoreClient.getConfigStoreVersionForBlock(deposit.quoteBlockNumber);
            if (version < UBA_MIN_CONFIG_STORE_VERSION) {
              throw new Error(
                `isUBAActivatedAtBlock claims UBA is activated as of deposit block ${deposit.blockNumber} but version at deposit time ${deposit.quoteBlockNumber} is ${version} which is below the minimum UBA version ${UBA_MIN_CONFIG_STORE_VERSION}`
              );
            }
          } else {
            // Deposit is not a UBA deposit, so use version at deposit quote timestamp:
            version = hubPoolClient.configStoreClient.getConfigStoreVersionForTimestamp(deposit.quoteTimestamp);
          }
          return { ...destinationClient.getValidUnfilledAmountForDeposit(deposit), deposit, version };
        });
      // Remove any deposits that have no unfilled amount and append the remaining deposits to unfilledDeposits array.
      unfilledDeposits.push(...unfilledDepositsForDestinationChain.filter((deposit) => deposit.unfilledAmount.gt(0)));
    }
  }

  return unfilledDeposits;
}
