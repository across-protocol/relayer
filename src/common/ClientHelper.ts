import winston from "winston";
import { getProvider, getSigner, getDeployedContract, getDeploymentBlockNumber, Wallet } from "../utils";
import { HubPoolClient, MultiCallerClient, AcrossConfigStoreClient } from "../clients";
import { CommonConfig } from "./Config";

export interface Clients {
  hubPoolClient: HubPoolClient;
  configStoreClient: AcrossConfigStoreClient;
  multiCallerClient: MultiCallerClient;
}

export function getSpokePoolSigners(baseSigner: Wallet, config: CommonConfig): { [chainId: number]: Wallet } {
  return Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      return [chainId, baseSigner.connect(getProvider(chainId, config.nodeQuorumThreshold))];
    })
  );
}

export async function constructClients(logger: winston.Logger, config: CommonConfig): Promise<Clients> {
  // Create signers for each chain. Each is connected to an associated provider for that chain.
  const baseSigner = await getSigner();

  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));

  // Create contract instances for each chain for each required contract.
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);

  const configStore = getDeployedContract("AcrossConfigStore", config.hubPoolChainId, hubSigner);

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

  // const gasEstimator = new GasEstimator() // todo when this is implemented in the SDK.
  const multiCallerClient = new MultiCallerClient(logger, null, config.maxTxWaitDuration);

  return { hubPoolClient, configStoreClient, multiCallerClient };
}

export async function updateClients(clients: Clients) {
  await Promise.all([clients.hubPoolClient.update(), clients.configStoreClient.update()]);
}
