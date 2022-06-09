import winston from "winston";
import { getSigner } from "../utils";
import { TokenClient } from "../clients";
import { RelayerConfig } from "./RelayerConfig";
import { Clients, constructClients, updateClients, updateSpokePoolClients } from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import { constructSpokePoolClientsWithLookback } from "../common";

export interface RelayerClients extends Clients {
  spokePoolClients: SpokePoolClientsByChain;
  tokenClient: TokenClient;
}

export async function constructRelayerClients(logger: winston.Logger, config: RelayerConfig): Promise<RelayerClients> {
  const baseSigner = await getSigner();

  const commonClients = await constructClients(logger, config);

  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.configStoreClient,
    config,
    baseSigner,
    config.maxRelayerLookBack
  );

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
