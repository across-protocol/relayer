import assert from "assert";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { Fill, FillStatus, SpokePoolClientsByChain, V2DepositWithBlock, V3DepositWithBlock } from "../interfaces";
import { getBlockForTimestamp, getRedisCache } from "../utils";
import { isDefined } from "./";
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
  const chainIds = Object.values(spokePoolClients).filter(({ isUpdated }) => isUpdated).map(({ chainId }) => chainId);
  const originFromBlocks: { [chainId: number]: number } = Object.fromEntries(
    Object.values(spokePoolClients).map(({ chainId, deploymentBlock }) => [chainId, deploymentBlock])
  );

  if (isDefined(depositLookBack)) {
    const blockFinder = undefined;
    const redis = await getRedisCache();
    await sdkUtils.forEachAsync(chainIds, async (originChainId: number) => {
      const spokePoolClient = spokePoolClients[originChainId];
      const timestamp = spokePoolClient.getCurrentTime() - depositLookBack;
      const hints = { lowBlock: spokePoolClient.deploymentBlock };
      const startBlock = await getBlockForTimestamp(originChainId, timestamp, blockFinder, redis, hints);
      originFromBlocks[originChainId] = Math.max(spokePoolClient.deploymentBlock, startBlock);
    });
  }

  // Iterate over each chainId and check for unfilled deposits.
  await sdkUtils.mapAsync(chainIds, async (destinationChainId: number) => {
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
      .filter(({ fillStatus }) => fillStatus !== FillStatus.Filled)
      .map(({ deposit, fillStatus }) => {
        const version = hubPoolClient.configStoreClient.getConfigStoreVersionForTimestamp(deposit.quoteTimestamp);
        const { invalidFills } = destinationClient.getValidUnfilledAmountForDeposit(deposit);
        return { deposit, version, fillStatus, invalidFills };
      });
  });

  return unfilledDeposits;
}
