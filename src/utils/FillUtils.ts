import { HubPoolClient, SpokePoolClient } from "../clients";
import { FillStatus, FillWithBlock, SpokePoolClientsByChain, DepositWithBlock } from "../interfaces";
import { bnZero, CHAIN_IDs } from "../utils";

export type RelayerUnfilledDeposit = {
  deposit: DepositWithBlock;
  version: number;
  invalidFills: FillWithBlock[];
};

// @description Returns all unfilled deposits, indexed by destination chain.
// @param destinationChainId  Chain ID to query outstanding deposits on.
// @param spokePoolClients  Mapping of chainIds to SpokePoolClient objects.
// @param hubPoolClient HubPoolClient instance.
// @returns Array of unfilled deposits.
export function getUnfilledDeposits(
  destinationSpokePoolClient: SpokePoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  hubPoolClient: HubPoolClient,
  fillStatus: { [deposit: string]: number } = {}
): RelayerUnfilledDeposit[] {
  const destinationChainId = destinationSpokePoolClient.chainId;
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
      const { unfilledAmount, invalidFills } = destinationSpokePoolClient.getValidUnfilledAmountForDeposit(deposit);
      return { deposit, unfilledAmount, invalidFills };
    })
    .filter(({ unfilledAmount }) => unfilledAmount.gt(bnZero))
    .map(({ deposit, ...rest }) => {
      const version = hubPoolClient.configStoreClient.getConfigStoreVersionForTimestamp(deposit.quoteTimestamp);
      return { deposit, ...rest, version };
    });
}

export function depositForcesOriginChainRepayment(
  deposit: Pick<DepositWithBlock, "inputToken" | "originChainId" | "fromLiteChain">,
  hubPoolClient: HubPoolClient
): boolean {
  return (
    deposit.fromLiteChain || !hubPoolClient.l2TokenHasPoolRebalanceRoute(deposit.inputToken, deposit.originChainId)
  );
}

/**
 * @notice Returns true if after filling this deposit, the repayment can be quickly rebalanced to a different chain.
 * @dev This function can be used by the InventoryClient and Relayer to help determine whether a deposit should
 * be filled or ignored given current inventory allocation levels.
 */
export function repaymentChainCanBeQuicklyRebalanced(
  deposit: Pick<DepositWithBlock, "originChainId">,
  hubPoolClient: HubPoolClient
): boolean {
  return [hubPoolClient.chainId, CHAIN_IDs.BSC].includes(deposit.originChainId);
}

export function getAllUnfilledDeposits(
  spokePoolClients: SpokePoolClientsByChain,
  hubPoolClient: HubPoolClient
): Record<number, RelayerUnfilledDeposit[]> {
  return Object.fromEntries(
    Object.values(spokePoolClients).map(({ chainId: destinationChainId }) => [
      destinationChainId,
      getUnfilledDeposits(spokePoolClients[destinationChainId], spokePoolClients, hubPoolClient),
    ])
  );
}
