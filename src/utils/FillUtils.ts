import { utils as sdkUtils } from "@across-protocol/sdk";
import { HubPoolClient } from "../clients";
import { Fill, FillStatus, SpokePoolClientsByChain, V3DepositWithBlock } from "../interfaces";
import { bnZero } from "../utils";
import { getBlockRangeForChain } from "../dataworker/DataworkerUtils";

export function getRefundInformationFromFill(
  fill: Fill,
  hubPoolClient: HubPoolClient,
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[],
  fromLiteChain: boolean
): {
  chainToSendRefundTo: number;
  repaymentToken: string;
} {
  // Handle slow relay where repaymentChainId = 0. Slow relays always pay recipient on destination chain.
  // So, save the slow fill under the destination chain, and save the fast fill under its repayment chain.
  let chainToSendRefundTo = sdkUtils.isSlowFill(fill) ? fill.destinationChainId : fill.repaymentChainId;
  // If the fill is for a deposit originating from the lite chain, the repayment chain is the origin chain
  // regardless of whether it is a slow or fast fill (we ignore slow fills but this is for posterity).
  if (fromLiteChain) {
    chainToSendRefundTo = fill.originChainId;
  }

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
  version: number;
  invalidFills: Fill[];
};

// @description Returns all unfilled deposits, indexed by destination chain.
// @param destinationChainId  Chain ID to query outstanding deposits on.
// @param spokePoolClients  Mapping of chainIds to SpokePoolClient objects.
// @param hubPoolClient HubPoolClient instance.
// @returns Array of unfilled deposits.
export function getUnfilledDeposits(
  destinationChainId: number,
  spokePoolClients: SpokePoolClientsByChain,
  hubPoolClient: HubPoolClient,
  fillStatus: { [deposit: string]: number } = {}
): RelayerUnfilledDeposit[] {
  const destinationClient = spokePoolClients[destinationChainId];

  // Iterate over each chainId and check for unfilled deposits.
  const deposits = Object.values(spokePoolClients)
    .filter(({ chainId, isUpdated }) => isUpdated && chainId !== destinationChainId)
    .flatMap((spokePoolClient) => spokePoolClient.getDepositsForDestinationChain(destinationChainId))
    .filter((deposit) => {
      const depositHash = spokePoolClients[deposit.originChainId].getDepositHash(deposit);
      return (fillStatus[depositHash] ?? FillStatus.Unfilled) !== FillStatus.Filled;
    });

  return deposits
    .map((deposit) => {
      const version = hubPoolClient.configStoreClient.getConfigStoreVersionForTimestamp(deposit.quoteTimestamp);
      const { unfilledAmount, invalidFills } = destinationClient.getValidUnfilledAmountForDeposit(deposit);
      return { deposit, version, unfilledAmount, invalidFills };
    })
    .filter(({ unfilledAmount }) => unfilledAmount.gt(bnZero));
}

export function getAllUnfilledDeposits(
  spokePoolClients: SpokePoolClientsByChain,
  hubPoolClient: HubPoolClient
): Record<number, RelayerUnfilledDeposit[]> {
  return Object.fromEntries(
    Object.values(spokePoolClients).map(({ chainId: destinationChainId }) => [
      destinationChainId,
      getUnfilledDeposits(destinationChainId, spokePoolClients, hubPoolClient),
    ])
  );
}
