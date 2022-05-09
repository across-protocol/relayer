import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import { Clients, constructClients, getSpokePoolSigners, updateClients } from "../common";
import { EventSearchConfig, getDeploymentBlockNumber, getSigner, Wallet } from "../utils";
import { TokenClient } from "../clients";

export interface DataworkerClients extends Clients {
  tokenClient: TokenClient;
  spokePoolSigners: { [chainId: number]: Wallet };
  spokePoolClientSearchSettings: { [chainId: number]: EventSearchConfig };
}

export async function constructDataworkerClients(
  logger: winston.Logger,
  config: DataworkerConfig
): Promise<DataworkerClients> {
  const commonClients = await constructClients(logger, config);
  const baseSigner = await getSigner();

  // We don't pass any spoke pool clients to token client since data worker doesn't need to set approvals for L2 tokens.
  const tokenClient = new TokenClient(logger, baseSigner.address, {}, commonClients.hubPoolClient);
  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);
  const spokePoolClientSearchSettings = Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      return [
        chainId,
        {
          fromBlock: Number(getDeploymentBlockNumber("SpokePool", chainId)),
          toBlock: null,
          maxBlockLookBack: config.maxBlockLookBack[chainId],
        },
      ];
    })
  );

  return { ...commonClients, tokenClient, spokePoolSigners, spokePoolClientSearchSettings };
}

// If this is the first run then the hubPoolClient will have no whitelisted routes. If this is the case then first
// update the hubPoolClient and the rateModelClients followed by the spokePoolClients. Else, update all at once.
export async function updateDataworkerClients(logger: winston.Logger, clients: DataworkerClients) {
  if (Object.keys(clients.hubPoolClient.getL1TokensToDestinationTokens()).length === 0) {
    await updateClients(clients);
    // Token client requires up to date spokePool clients to fetch token routes.
    await clients.tokenClient.update();
  } else {
    logger.debug({ at: "ClientHelper", message: "Updating clients for standard run" });
    await Promise.all([updateClients(clients), clients.tokenClient.update()]);
  }

  // Run approval on hub pool.
  await clients.tokenClient.setBondTokenAllowance();
}
