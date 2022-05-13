import winston from "winston";
import { Contract, getDeployedContract, getDeploymentBlockNumber, getSigner } from "../utils";
import { TokenClient, ProfitClient, SpokePoolClient, InventoryClient } from "../clients";
import { RelayerConfig } from "./RelayerConfig";
import { Clients, constructClients, updateClients, getSpokePoolSigners } from "../common";

export interface RelayerClients extends Clients {
  spokePoolClients: { [chainId: number]: SpokePoolClient };
  tokenClient: TokenClient;
  profitClient: ProfitClient;
  inventoryClient: InventoryClient;
}

export async function constructRelayerClients(logger: winston.Logger, config: RelayerConfig): Promise<RelayerClients> {
  const baseSigner = await getSigner();

  const commonClients = await constructClients(logger, config);

  // Create clients for each contract for each chain.
  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);

  const spokePools = config.spokePoolChains.map((networkId) => {
    return { networkId, contract: getDeployedContract("SpokePool", networkId, spokePoolSigners[networkId]) };
  });
  const spokePoolClients = {};
  spokePools.forEach((obj: { networkId: number; contract: Contract }) => {
    const spokePoolClientSearchSettings = {
      fromBlock: Number(getDeploymentBlockNumber("SpokePool", obj.networkId)),
      toBlock: null,
      maxBlockLookBack: config.maxBlockLookBack[obj.networkId],
    };
    spokePoolClients[obj.networkId] = new SpokePoolClient(
      logger,
      obj.contract,
      commonClients.configStoreClient,
      obj.networkId,
      spokePoolClientSearchSettings
    );
  });

  const tokenClient = new TokenClient(logger, baseSigner.address, spokePoolClients);

  const profitClient = new ProfitClient(logger, commonClients.hubPoolClient, config.relayerDiscount);

  const inventoryClient = new InventoryClient(
    logger,
    config.inventorySettings,
    tokenClient,
    commonClients.hubPoolClient,
    config.spokePoolChains
  );

  return { ...commonClients, spokePoolClients, tokenClient, profitClient, inventoryClient };
}

// If this is the first run then the hubPoolClient will have no whitelisted routes. If this is the case then first
// update the hubPoolClient and the rateModelClients followed by the spokePoolClients. Else, update all at once.
export async function updateRelayerClients(logger: winston.Logger, clients: RelayerClients) {
  if (Object.keys(clients.hubPoolClient.getL1TokensToDestinationTokens()).length === 0) {
    await updateClients(clients);
    // Profit and SpokePoolClient client requires up to date HubPoolClient and rateModelClient.
    // Token client requires up to date spokePool clients to fetch token routes.
    await Promise.all([clients.profitClient.update(), updateSpokePoolClients(clients.spokePoolClients)]);
    await clients.tokenClient.update();
  } else {
    logger.debug({ at: "ClientHelper", message: "Updating clients for standard run" });
    await Promise.all([
      updateClients(clients),
      updateSpokePoolClients(clients.spokePoolClients),
      clients.tokenClient.update(),
      clients.profitClient.update(),
    ]);
  }

  // Run approval check last as needs up to date route info. If no new then returns with no async calls.
  await clients.tokenClient.setOriginTokenApprovals();

  // Run inventory rebalance last as needs up to date info from all other clients and token approvals.
  await clients.inventoryClient.rebalanceInventoryIfNeeded();
}

async function updateSpokePoolClients(spokePoolClients: { [chainId: number]: SpokePoolClient }) {
  await Promise.all(Object.values(spokePoolClients).map((client) => client.update()));
}
