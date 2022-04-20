import winston from "winston";
import { getProvider, getSigner, getDeployedContract, getDeploymentBlockNumber, Contract } from "../utils";
import { SpokePoolClient, HubPoolClient, RateModelClient, TokenClient, MultiCallerClient } from ".";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { Clients } from "./ClientHelper";

export interface RelayerClients extends Clients {
  tokenClient: TokenClient;
}

export function constructRelayerClients(logger: winston.Logger, config: RelayerConfig): RelayerClients {
  // Create signers for each chain. Each is connected to an associated provider for that chain.
  const baseSigner = getSigner();

  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const spokeSigners = config.spokePoolChains
    .map((networkId) => getProvider(networkId, config.nodeQuorumThreshold))
    .map((provider) => baseSigner.connect(provider));

  // Create contract instances for each chain for each required contract.
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);

  const rateModelStore = getDeployedContract("RateModelStore", config.hubPoolChainId, hubSigner);

  // Create clients for each contract for each chain.
  const spokePools = config.spokePoolChains.map((networkId, index) => {
    return { networkId, contract: getDeployedContract("SpokePool", networkId, spokeSigners[index]) };
  });

  const hubPoolClientSearchSettings = {
    fromBlock: getDeploymentBlockNumber("HubPool", config.hubPoolChainId),
    toBlock: null,
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };
  const hubPoolClient = new HubPoolClient(logger, hubPool, hubPoolClientSearchSettings);

  const rateModelClientSearchSettings = {
    fromBlock: getDeploymentBlockNumber("RateModelStore", config.hubPoolChainId),
    toBlock: null,
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };
  const rateModelClient = new RateModelClient(logger, rateModelStore, hubPoolClient, rateModelClientSearchSettings);

  let spokePoolClients = {};
  spokePools.forEach((obj: { networkId: number; contract: Contract }) => {
    const spokePoolClientSearchSettings = {
      fromBlock: getDeploymentBlockNumber("SpokePool", obj.networkId),
      toBlock: null,
      maxBlockLookBack: config.maxBlockLookBack[obj.networkId],
    };
    spokePoolClients[obj.networkId] = new SpokePoolClient(
      logger,
      obj.contract,
      rateModelClient,
      obj.networkId,
      spokePoolClientSearchSettings
    );
  });

  const tokenClient = new TokenClient(logger, baseSigner.address, spokePoolClients);

  // const gasEstimator = new GasEstimator() // todo when this is implemented in the SDK.
  const multiCallerClient = new MultiCallerClient(logger, null);

  logger.debug({
    at: "constructClients",
    message: "Clients constructed",
    hubPool: hubPool.address,
    rateModelStore: rateModelStore.address,
    spokePools: spokePools.map((spokePool) => {
      return { networkId: spokePool.networkId, spokePool: spokePool.contract.address };
    }),
  });

  return { hubPoolClient, rateModelClient, spokePoolClients, tokenClient, multiCallerClient };
}

// If this is the first run then the hubPoolClient will have no whitelisted routes. If this is the case then first
// update the hubPoolClient and the rateModelClients followed by the spokePoolClients. Else, update all at once.
export async function updateRelayerClients(logger: winston.Logger, clients: RelayerClients) {
  if (Object.keys(clients.hubPoolClient.getL1TokensToDestinationTokens()).length === 0) {
    logger.debug({ at: "ClientHelper", message: "Updating clients for first run" });
    await Promise.all([clients.hubPoolClient.update(), clients.rateModelClient.update()]);
    await updateSpokePoolClients(clients.spokePoolClients);
    await clients.tokenClient.update(); // Token client requires up to date spokePool clients to fetch token routes.
  } else {
    logger.debug({ at: "ClientHelper", message: "Updating clients for standard run" });
    await Promise.all([
      clients.hubPoolClient.update(),
      clients.rateModelClient.update(),
      clients.tokenClient.update(),
      updateSpokePoolClients(clients.spokePoolClients),
    ]);
  }

  // Run approval check last as needs up to date route info. If no new then returns with no async calls.
  await clients.tokenClient.setOriginTokenApprovals();
}

async function updateSpokePoolClients(spokePoolClients: { [chainId: number]: SpokePoolClient }) {
  await Promise.all(Object.values(spokePoolClients).map((client) => client.update()));
}
