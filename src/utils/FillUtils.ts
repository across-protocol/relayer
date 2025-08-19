import { HubPoolClient, SpokePoolClient } from "../clients";
import { FillStatus, FillWithBlock, SpokePoolClientsByChain, DepositWithBlock, RelayData } from "../interfaces";
import { CHAIN_IDs, EMPTY_MESSAGE } from "../utils";

export type RelayerUnfilledDeposit = {
  deposit: DepositWithBlock;
  version: number;
  invalidFills: FillWithBlock[];
};

// @description Returns RelayData object with empty message.
// @param fill  FillWithBlock object.
// @returns RelayData object.
export function getRelayDataFromFill(fill: FillWithBlock): RelayData {
  return {
    originChainId: fill.originChainId,
    depositor: fill.depositor,
    recipient: fill.recipient,
    depositId: fill.depositId,
    inputToken: fill.inputToken,
    inputAmount: fill.inputAmount,
    outputToken: fill.outputToken,
    outputAmount: fill.outputAmount,
    message: EMPTY_MESSAGE,
    fillDeadline: fill.fillDeadline,
    exclusiveRelayer: fill.exclusiveRelayer,
    exclusivityDeadline: fill.exclusivityDeadline,
  };
}

// @description Returns all unfilled deposits, indexed by destination chain.
// @param destinationChainId  Chain ID to query outstanding deposits on.
// @param spokePoolClients  Mapping of chainIds to SpokePoolClient objects.
// @param hubPoolClient HubPoolClient instance.
// @returns Array of unfilled deposits.
export function getUnfilledDeposits(
  destinationSpokePoolClient: SpokePoolClient,
  originSpokePoolClients: SpokePoolClientsByChain,
  hubPoolClient: HubPoolClient,
  fillStatus: { [deposit: string]: number } = {}
): RelayerUnfilledDeposit[] {
  const destinationChainId = destinationSpokePoolClient.chainId;
  // Iterate over each chainId and check for unfilled deposits.
  const deposits = Object.values(originSpokePoolClients)
    .filter(({ chainId, isUpdated }) => isUpdated && chainId !== destinationChainId)
    .flatMap((spokePoolClient) => spokePoolClient.getDepositsForDestinationChain(destinationChainId))
    .filter((deposit) => {
      // It would be preferable to use host time since it's more reliably up-to-date, but this creates issues in test.
      const currentTime = destinationSpokePoolClient.getCurrentTime();
      if (deposit.fillDeadline <= currentTime) {
        return false;
      }

      const depositHash = originSpokePoolClients[deposit.originChainId].getDepositHash(deposit);
      return (fillStatus[depositHash] ?? FillStatus.Unfilled) !== FillStatus.Filled;
    });

  return deposits
    .filter((deposit) => {
      return !destinationSpokePoolClient.isDepositFilled(deposit);
    })
    .map((deposit) => {
      const invalidFills = destinationSpokePoolClient.getFillsForDeposit(deposit);
      const version = hubPoolClient.configStoreClient.getConfigStoreVersionForTimestamp(deposit.quoteTimestamp);
      return { deposit, version, invalidFills };
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
