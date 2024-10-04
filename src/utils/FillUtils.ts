import { HubPoolClient } from "../clients";
import { Fill, FillStatus, SpokePoolClientsByChain, DepositWithBlock } from "../interfaces";
import { bnZero } from "../utils";

export type RelayerUnfilledDeposit = {
  deposit: DepositWithBlock;
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
      const { unfilledAmount, invalidFills } = destinationClient.getValidUnfilledAmountForDeposit(deposit);
      return { deposit, unfilledAmount, invalidFills };
    })
    .filter(({ unfilledAmount }) => unfilledAmount.gt(bnZero))
    .map(({ deposit, ...rest }) => {
      const version = hubPoolClient.configStoreClient.getConfigStoreVersionForTimestamp(deposit.quoteTimestamp);
      return { deposit, ...rest, version };
    });
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
