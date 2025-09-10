import { constants } from "@across-protocol/sdk";
import { SpokePoolClient } from "../../src/clients";

/**
 * This is a helper function to generate an array of empty objects that are typed as SpokePoolClients.
 * Several locations in our tests require an array of SpokePoolClients, but the actual values of the
 * SpokePoolClients are not important. This is because we need at least one spoke pool client for every
 * available chain and we don't usually need all of the available spoke clients.
 * @param desiredClients An optional object that contains the desired spoke pool clients. If set, this will override/append to the default clients.
 * @returns An array of empty objects that are typed as SpokePoolClients
 */
export function generateNoOpSpokePoolClientsForDefaultChainIndices(
  desiredClients?: Record<string, SpokePoolClient>
): Record<string, SpokePoolClient> {
  const defaultClients = Object.fromEntries(
    constants.PROTOCOL_DEFAULT_CHAIN_ID_INDICES.map((chainId) => [
      chainId,
      { isUpdated: true } as unknown as SpokePoolClient,
    ])
  );
  return {
    ...defaultClients,
    ...(desiredClients ?? {}),
  };
}
