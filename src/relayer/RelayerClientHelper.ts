import winston from "winston";
import { getSigner } from "../utils";
import { TokenClient, SpokePoolClient } from "../clients";
import { RelayerConfig } from "./RelayerConfig";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithLookback,
  updateClients,
  updateSpokePoolClients,
} from "../common";

export interface RelayerClients extends Clients {
  spokePoolClients: { [chainId: number]: SpokePoolClient };
  tokenClient: TokenClient;
}

export async function constructRelayerClients(logger: winston.Logger, config: RelayerConfig): Promise<RelayerClients> {
  const baseSigner = await getSigner();

  const commonClients = await constructClients(logger, config);

  const spokePoolClients = await constructSpokePoolClientsWithLookback(logger, commonClients, config, baseSigner);

  const tokenClient = new TokenClient(logger, baseSigner.address, spokePoolClients, commonClients.hubPoolClient);

  return { ...commonClients, tokenClient, spokePoolClients };
}

export async function updateRelayerClients(clients: RelayerClients) {
  await updateClients(clients);
  // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.
  await updateSpokePoolClients(clients.spokePoolClients);
  // Token client requires up to date spokePool clients to fetch token routes.
  await clients.tokenClient.update();

  // Run approval check last as needs up to date route info. If no new then returns with no async calls.
  await clients.tokenClient.setOriginTokenApprovals();
}
