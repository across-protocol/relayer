import winston from "winston";
import { getSigner } from "../utils";
import { TokenClient, ProfitClient } from ".";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { Clients, constructClients, updateClients } from "../common";

export interface RelayerClients extends Clients {
  tokenClient: TokenClient;
  profitClient: ProfitClient;
}

export async function constructRelayerClients(logger: winston.Logger, config: RelayerConfig): Promise<RelayerClients> {
  const baseSigner = await getSigner();

  const commonClients = await constructClients(logger, config);

  const tokenClient = new TokenClient(logger, baseSigner.address, commonClients.spokePoolClients);

  const profitClient = new ProfitClient(logger, commonClients.hubPoolClient, config.relayerDiscount);

  return { ...commonClients, tokenClient, profitClient };
}

export async function updateRelayerClients(logger: winston.Logger, clients: RelayerClients) {
  if (Object.keys(clients.hubPoolClient.getL1TokensToDestinationTokens()).length === 0) {
    await updateClients(logger, clients);
    // Profit client requires up to date HuPoolClient and rateModelClient.
    // Token client requires up to date spokePool clients to fetch token routes.
    await Promise.all([clients.profitClient.update(), clients.tokenClient.update()]);
  } else {
    logger.debug({ at: "ClientHelper", message: "Updating clients for standard run" });
    await Promise.all([updateClients(logger, clients), clients.tokenClient.update(), clients.profitClient.update()]);
  }

  // Run approval check last as needs up to date route info. If no new then returns with no async calls.
  await clients.tokenClient.setOriginTokenApprovals();
}
