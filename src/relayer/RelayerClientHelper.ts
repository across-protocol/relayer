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

  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);

  const spokePools = config.spokePoolChains.map((networkId) => {
    return { networkId, contract: getDeployedContract("SpokePool", networkId, spokePoolSigners[networkId]) };
  });
  const spokePoolClients = {};

  // If maxRelayerLookBack is set then offset the fromBlock to the latest - maxRelayerLookBack. Used in serverless mode.
  let fromBlocks = {};
  if (config.maxRelayerLookBack != {}) {
    const l2BlockNumbers = await Promise.all(
      spokePools.map((obj: { contract: Contract }) => obj.contract.provider.getBlockNumber())
    );
    spokePools.forEach((obj: { networkId: number; contract: Contract }, index) => {
      if (config.maxRelayerLookBack[obj.networkId])
        fromBlocks[obj.networkId] = l2BlockNumbers[index] - config.maxRelayerLookBack[obj.networkId];
    });
  }

  spokePools.forEach((obj: { networkId: number; contract: Contract }) => {
    const spokePoolDeploymentBlock = getDeploymentBlockNumber("SpokePool", obj.networkId);
    const spokePoolClientSearchSettings = {
      fromBlock: fromBlocks[obj.networkId] ?? spokePoolDeploymentBlock,
      toBlock: null,
      maxBlockLookBack: config.maxBlockLookBack[obj.networkId],
    };
    spokePoolClients[obj.networkId] = new SpokePoolClient(
      logger,
      obj.contract,
      commonClients.configStoreClient,
      obj.networkId,
      spokePoolClientSearchSettings,
      spokePoolDeploymentBlock
    );
  });

  const tokenClient = new TokenClient(logger, baseSigner.address, spokePoolClients, commonClients.hubPoolClient);

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

export async function updateRelayerClients(clients: RelayerClients) {
  await updateClients(clients);
  // Profit and SpokePoolClient client requires up to date HubPoolClient and rateModelClient.
  // Token client requires up to date spokePool clients to fetch token routes.
  await Promise.all([clients.profitClient.update(), updateSpokePoolClients(clients.spokePoolClients)]);
  await clients.tokenClient.update();

  // Run approval check last as needs up to date route info. If no new then returns with no async calls.
  await clients.tokenClient.setOriginTokenApprovals();

  // Run inventory rebalance last as needs up to date info from all other clients and token approvals.
  await clients.inventoryClient.rebalanceInventoryIfNeeded();
}

async function updateSpokePoolClients(spokePoolClients: { [chainId: number]: SpokePoolClient }) {
  await Promise.all(Object.values(spokePoolClients).map((client) => client.update()));
}
