import winston from "winston";
import { getProvider, getSigner, getDeployedContract, getDeploymentBlockNumber, Contract } from "../utils";
import { SpokePoolClient, HubPoolClient, MultiCallerClient, AcrossConfigStoreClient } from "../clients";
import { CommonConfig } from "./Config";

export interface Clients {
  spokePoolClients: { [chainId: number]: SpokePoolClient };
  hubPoolClient: HubPoolClient;
  configStoreClient: AcrossConfigStoreClient;
  multiCallerClient: MultiCallerClient;
}

export async function constructClients(logger: winston.Logger, config: CommonConfig): Promise<Clients> {
  // Create signers for each chain. Each is connected to an associated provider for that chain.
  const baseSigner = await getSigner();

  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const spokeSigners = config.spokePoolChains
    .map((networkId) => getProvider(networkId, config.nodeQuorumThreshold))
    .map((provider) => baseSigner.connect(provider));

  // Create contract instances for each chain for each required contract.
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);

  const configStore = getDeployedContract("AcrossConfigStore", config.hubPoolChainId, hubSigner);

  // Create clients for each contract for each chain.
  const spokePools = config.spokePoolChains.map((networkId, index) => {
    return { networkId, contract: getDeployedContract("SpokePool", networkId, spokeSigners[index]) };
  });

  const hubPoolClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("HubPool", config.hubPoolChainId)),
    toBlock: null,
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };
  const hubPoolClient = new HubPoolClient(logger, hubPool, hubPoolClientSearchSettings);

  const rateModelClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("AcrossConfigStore", config.hubPoolChainId)),
    toBlock: null,
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };
  const configStoreClient = new AcrossConfigStoreClient(
    logger,
    configStore,
    hubPoolClient,
    rateModelClientSearchSettings
  );

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
      configStoreClient,
      obj.networkId,
      spokePoolClientSearchSettings
    );
  });

  // const gasEstimator = new GasEstimator() // todo when this is implemented in the SDK.
  const multiCallerClient = new MultiCallerClient(logger, null);

  logger.debug({
    at: "constructClients",
    message: "Clients constructed",
    relayerWallet: baseSigner.address,
    hubPool: hubPool.address,
    configStore: configStore.address,
    spokePools: spokePools.map((spokePool) => {
      return { networkId: spokePool.networkId, spokePool: spokePool.contract.address };
    }),
  });

  return { hubPoolClient, configStoreClient, spokePoolClients, multiCallerClient };
}

// If this is the first run then the hubPoolClient will have no whitelisted routes. If this is the case then first
// update the hubPoolClient and the rateModelClients followed by the spokePoolClients. Else, update all at once.
export async function updateClients(logger: winston.Logger, clients: Clients) {
  if (Object.keys(clients.hubPoolClient.getL1TokensToDestinationTokens()).length === 0) {
    logger.debug({ at: "ClientHelper", message: "Updating clients for first run" });
    await Promise.all([clients.hubPoolClient.update(), clients.configStoreClient.update()]);
    // SpokePool clientrequires up to date HuPoolClient and rateModelClient.
    await updateSpokePoolClients(clients.spokePoolClients);
  } else {
    logger.debug({ at: "ClientHelper", message: "Updating clients for standard run" });
    await Promise.all([
      clients.hubPoolClient.update(),
      clients.configStoreClient.update(),
      updateSpokePoolClients(clients.spokePoolClients),
    ]);
  }
}

async function updateSpokePoolClients(spokePoolClients: { [chainId: number]: SpokePoolClient }) {
  await Promise.all(Object.values(spokePoolClients).map((client) => client.update()));
}
