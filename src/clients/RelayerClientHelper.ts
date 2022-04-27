import winston from "winston";
import { getProvider, getSigner, getDeployedContract, Contract } from "../utils";
import { SpokePoolClient, HubPoolClient, RateModelClient, TokenClient, ProfitClient, MultiCallerClient } from ".";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { Clients } from "./ClientHelper";

export interface RelayerClients extends Clients {
  tokenClient: TokenClient;
  profitClient: ProfitClient;
  multiCallerClient: MultiCallerClient;
}

export async function constructRelayerClients(logger: winston.Logger, config: RelayerConfig): Promise<RelayerClients> {
  // Create signers for each chain. Each is connected to an associated provider for that chain.
  const baseSigner = await getSigner();

  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const spokeSigners = config.spokePoolChains
    .map((networkId) => getProvider(networkId))
    .map((provider) => baseSigner.connect(provider));

  // Create contract instances for each chain for each required contract.
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);

  const rateModelStore = getDeployedContract("RateModelStore", config.hubPoolChainId, hubSigner);

  // Create clients for each contract for each chain.
  const spokePools = config.spokePoolChains.map((networkId, index) => {
    return { networkId, contract: getDeployedContract("SpokePool", networkId, spokeSigners[index]) };
  });

  const hubPoolClient = new HubPoolClient(logger, hubPool);

  const rateModelClient = new RateModelClient(logger, rateModelStore, hubPoolClient);

  const spokePoolClients = {};
  spokePools.forEach((obj: { networkId: number; contract: Contract }) => {
    spokePoolClients[obj.networkId] = new SpokePoolClient(logger, obj.contract, rateModelClient, obj.networkId);
  });

  const tokenClient = new TokenClient(logger, baseSigner.address, spokePoolClients);

  const profitClient = new ProfitClient(logger, hubPoolClient, config.relayerDiscount);

  // const gasEstimator = new GasEstimator() // todo when this is implemented in the SDK.
  const multiCallerClient = new MultiCallerClient(logger, null);

  logger.debug({
    at: "constructClients",
    message: "Clients constructed",
    relayerWallet: baseSigner.address,
    hubPool: hubPool.address,
    rateModelStore: rateModelStore.address,
    spokePools: spokePools.map((spokePool) => {
      return { networkId: spokePool.networkId, spokePool: spokePool.contract.address };
    }),
  });

  return { hubPoolClient, rateModelClient, spokePoolClients, tokenClient, profitClient, multiCallerClient };
}

// If this is the first run then the hubPoolClient will have no whitelisted routes. If this is the case then first
// update the hubPoolClient and the rateModelClients followed by the spokePoolClients. Else, update all at once.
export async function updateRelayerClients(logger: winston.Logger, clients: RelayerClients) {
  if (Object.keys(clients.hubPoolClient.getL1TokensToDestinationTokens()).length === 0) {
    logger.debug({ at: "ClientHelper", message: "Updating clients for first run" });
    await Promise.all([clients.hubPoolClient.update(), clients.rateModelClient.update()]);
    // SpokePool client and profit client requires up to date HuPoolClient and rateModelClient.
    await Promise.all([updateSpokePoolClients(clients.spokePoolClients), clients.profitClient.update()]);
    await clients.tokenClient.update(); // Token client requires up to date spokePool clients to fetch token routes.
  } else {
    logger.debug({ at: "ClientHelper", message: "Updating clients for standard run" });
    await Promise.all([
      clients.hubPoolClient.update(),
      clients.rateModelClient.update(),
      clients.tokenClient.update(),
      clients.profitClient.update(),
      updateSpokePoolClients(clients.spokePoolClients),
    ]);
  }

  // Run approval check last as needs up to date route info. If no new then returns with no async calls.
  await clients.tokenClient.setOriginTokenApprovals();
}

async function updateSpokePoolClients(spokePoolClients: { [chainId: number]: SpokePoolClient }) {
  await Promise.all(Object.values(spokePoolClients).map((client) => client.update()));
}
