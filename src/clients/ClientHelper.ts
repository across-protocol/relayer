import winston from "winston";
import { getProvider, getSigner, contractAt, Contract } from "../utils";
import { RateModelClient } from "./RateModelClient";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { MultiCallBundler } from "./MultiCallBundler";

export function constructClients(logger: winston.Logger, config: RelayerConfig) {
  // Create signers for each chain. Each is connected to an associated provider for that chain.
  const baseSigner = getSigner();

  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const spokeSigners = config.spokePoolChains
    .map((networkId) => getProvider(networkId))
    .map((provider) => baseSigner.connect(provider));

  // Create contract instances for each chain for each required contract.
  const hubPool = contractAt("HubPool", getAddress("HubPool", config.hubPoolChainId), hubSigner);

  const rateModelStore = contractAt("RateModelStore", getAddress("RateModelStore", config.hubPoolChainId), hubSigner);

  const spokePools = config.spokePoolChains.map((networkId, index) => {
    return { networkId, contract: contractAt("SpokePool", getAddress("SpokePool", networkId), spokeSigners[index]) };
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

// TODO: this method is temp to enable this constructor to work. this should be replaced by a method from the contracts
// package that exports the relationship between contractName and the associated chain they are deployed on.
function getAddress(contractName: string, chainId: number) {
  const mapping = {
    RateModelStore: { 42: "0x5923929DF7A2D6E038bb005B167c1E8a86cd13C8" },
    HubPool: { 42: "0xD449Af45a032Df413b497A709EeD3E8C112EbcE3" },
    SpokePool: {
      42: "0x73549B5639B04090033c1E77a22eE9Aa44C2eBa0",
      69: "0x2b7b7bAE341089103dD22fa4e8D7E4FA63E11084",
    },
  };
  return mapping[contractName][chainId];
}
