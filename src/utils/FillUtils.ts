import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { HubPoolClient } from "../clients";
import { Fill, FillStatus, SpokePoolClientsByChain, V3DepositWithBlock } from "../interfaces";
import { bnZero, getNetworkError, getNetworkName, winston } from "../utils";
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

  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    fill.inputToken,
    fill.originChainId,
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
  logger?: winston.Logger
): Promise<{ [chainId: number]: RelayerUnfilledDeposit[] }> {
  const unfilledDeposits: { [chainId: number]: RelayerUnfilledDeposit[] } = {};
  const chainIds = Object.values(spokePoolClients)
    .filter(({ isUpdated }) => isUpdated)
    .map(({ chainId }) => chainId);

  // Iterate over each chainId and check for unfilled deposits.
  await sdkUtils.mapAsync(chainIds, async (destinationChainId: number) => {
    const destinationClient = spokePoolClients[destinationChainId];

    // For each destination chain, query each _other_ SpokePool for deposits within the lookback.
    const deposits = chainIds
      .filter((chainId) => chainId !== destinationChainId)
      .map((originChainId) => spokePoolClients[originChainId].getDepositsForDestinationChain(destinationChainId))
      .flat();

    // Resolve the latest fill status for each deposit and filter out any that are now filled.
    let fillStatus: number[];
    try {
      fillStatus = await sdkUtils.fillStatusArray(destinationClient.spokePool, deposits);
    } catch (err) {
      const chain = getNetworkName(destinationClient.chainId);
      logger?.warn({
        at: "getUnfilledDeposits",
        message: `Failed to resolve status of ${deposits.length} fills on on ${chain}, reverting to iterative pairing.`,
        reason: getNetworkError(err),
      });

      // Fall back to matching fills against deposits and infer FillStatus from that.
      fillStatus = deposits
        .map((deposit) => destinationClient.getValidUnfilledAmountForDeposit(deposit))
        .map(({ unfilledAmount }) => (unfilledAmount.eq(bnZero) ? FillStatus.Filled : FillStatus.Unfilled));
    }

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
