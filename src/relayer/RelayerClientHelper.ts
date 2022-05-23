import winston from "winston";
import { Contract, getDeployedContract, getDeploymentBlockNumber, getSigner, Wallet } from "../utils";
import { TokenClient, ProfitClient, SpokePoolClient } from "../clients";
import { RelayerConfig } from "./RelayerConfig";
import { Clients, constructClients, updateClients, getSpokePoolSigners, updateSpokePoolClients } from "../common";

export interface RelayerClients extends Clients {
  spokePoolClients: { [chainId: number]: SpokePoolClient };
  tokenClient: TokenClient;
}

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient;
}

export async function constructSpokePoolClientsWithLookback(
  logger: winston.Logger,
  clients: Clients,
  config: RelayerConfig,
  baseSigner: Wallet
): Promise<SpokePoolClientsByChain> {
  const spokePoolClients: SpokePoolClientsByChain = {};

  // Set up Spoke signers and connect them to spoke pool contract objects:
  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);
  const spokePools = config.spokePoolChains.map((networkId) => {
    return { networkId, contract: getDeployedContract("SpokePool", networkId, spokePoolSigners[networkId]) };
  });

  // For each spoke chain, look up its latest block and adjust by lookback configuration to determine
  // fromBlock. If no lookback is set, fromBlock will be set to spoke pool's deployment block.
  const fromBlocks = {};
  const l2BlockNumbers = await Promise.all(
    spokePools.map((obj: { contract: Contract }) => obj.contract.provider.getBlockNumber())
  );
  spokePools.forEach((obj: { networkId: number; contract: Contract }, index) => {
    if (config.maxRelayerLookBack[obj.networkId])
      fromBlocks[obj.networkId] = l2BlockNumbers[index] - config.maxRelayerLookBack[obj.networkId];
  });

  // Create client for each spoke pool.
  spokePools.forEach((obj: { networkId: number; contract: Contract }) => {
    const spokePoolDeploymentBlock = getDeploymentBlockNumber("SpokePool", obj.networkId);
    const spokePoolClientSearchSettings = {
      fromBlock: fromBlocks[obj.networkId]
        ? Math.max(fromBlocks[obj.networkId], spokePoolDeploymentBlock)
        : spokePoolDeploymentBlock,
      toBlock: null,
      maxBlockLookBack: config.maxBlockLookBack[obj.networkId],
    };
    spokePoolClients[obj.networkId] = new SpokePoolClient(
      logger,
      obj.contract,
      clients.configStoreClient,
      obj.networkId,
      spokePoolClientSearchSettings,
      spokePoolDeploymentBlock
    );
  });

  return spokePoolClients;
}

export async function constructRelayerClients(logger: winston.Logger, config: RelayerConfig): Promise<RelayerClients> {
  const baseSigner = await getSigner();

  const commonClients = await constructClients(logger, config);

  const spokePoolClients = await constructSpokePoolClientsWithLookback(logger, commonClients, config, baseSigner);

  const tokenClient = new TokenClient(logger, baseSigner.address, spokePoolClients, commonClients.hubPoolClient);

  const profitClient = new ProfitClient(logger, commonClients.hubPoolClient, config.relayerDiscount);

  return { ...commonClients, tokenClient, profitClient, spokePoolClients };
}

export async function updateRelayerClients(clients: RelayerClients) {
  await updateClients(clients);
  // Profit and SpokePoolClient client requires up to date HubPoolClient and rateModelClient.
  // Token client requires up to date spokePool clients to fetch token routes.
  await Promise.all([clients.profitClient.update(), updateSpokePoolClients(clients.spokePoolClients)]);
  await clients.tokenClient.update();

  // Run approval check last as needs up to date route info. If no new then returns with no async calls.
  await clients.tokenClient.setOriginTokenApprovals();
}
