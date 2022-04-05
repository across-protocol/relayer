import winston from "winston";
import { getProvider, getSigner, getDeployedContract, Contract } from "../utils";
import { SpokePoolClient, HubPoolClient, RateModelClient, MultiCallBundler } from "./";
import { RelayerConfig } from "../relayer/RelayerConfig";

export function constructClients(logger: winston.Logger, config: RelayerConfig) {
  // Create signers for each chain. Each is connected to an associated provider for that chain.
  const baseSigner = getSigner();

  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const spokeSigners = config.spokePoolChains
    .map((networkId) => getProvider(networkId))
    .map((provider) => baseSigner.connect(provider));

  // Create contract instances for each chain for each required contract.
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);

  const rateModelStore = getDeployedContract("RateModelStore", config.hubPoolChainId, hubSigner);

  const spokePools = config.spokePoolChains.map((networkId, index) => {
    return { networkId, contract: getDeployedContract("SpokePool", networkId, spokeSigners[index]) };
  });

  // Create clients for each contract for each chain.

  const hubPoolClient = new HubPoolClient(logger, hubPool);

  const rateModelClient = new RateModelClient(logger, rateModelStore, hubPoolClient);

  let spokePoolClients = {};
  spokePools.forEach((obj: { networkId: number; contract: Contract }) => {
    spokePoolClients[obj.networkId] = new SpokePoolClient(logger, obj.contract, rateModelClient, obj.networkId);
  });

  // const gasEstimator = new GasEstimator() // todo when this is implemented in the SDK.
  const multiCallBundler = new MultiCallBundler(logger, null);

  logger.debug({
    at: "constructClients",
    message: "Clients constructed",
    hubPool: hubPool.address,
    rateModelStore: rateModelStore.address,
    spokePools: spokePools.map((spokePool) => {
      return { networkId: spokePool.networkId, spokePool: spokePool.contract.address };
    }),
  });

  return { hubPoolClient, rateModelClient, spokePoolClients, multiCallBundler };
}

// If this is the first run then the hubPoolClient will have no whitelisted routes. If this is the case then first
// update the hubPoolClient and the rateModelClients followed by the spokePoolClients. Else, update all at once.
export async function updateClients(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  rateModelClient: RateModelClient,
  spokePoolClients: { [chainId: number]: SpokePoolClient }
) {
  if (Object.keys(hubPoolClient.getL1TokensToDestinationTokens()).length === 0) {
    logger.debug({ at: "ClientHelper", message: "Updating clients for first run" });
    await Promise.all([hubPoolClient.update(), rateModelClient.update()]);
    await updateSpokePoolClients(spokePoolClients);
  } else {
    logger.debug({ at: "ClientHelper", message: "Updating clients for standard run" });
    await Promise.all([hubPoolClient.update(), rateModelClient.update(), updateSpokePoolClients(spokePoolClients)]);
  }
}

async function updateSpokePoolClients(spokePoolClients: { [chainId: number]: SpokePoolClient }) {
  await Promise.all(Object.values(spokePoolClients).map((client) => client.update()));
}
