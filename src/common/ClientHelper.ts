import winston from "winston";
import {
  getProvider,
  getSigner,
  getDeployedContract,
  getDeploymentBlockNumber,
  Wallet,
  SpokePool,
  Contract,
} from "../utils";
import { HubPoolClient, MultiCallerClient, AcrossConfigStoreClient, SpokePoolClient, ProfitClient } from "../clients";
import { CommonConfig } from "./Config";
import { DataworkerClients } from "../dataworker/DataworkerClientHelper";
import { createClient } from "redis4";

export interface Clients {
  hubPoolClient: HubPoolClient;
  configStoreClient: AcrossConfigStoreClient;
  multiCallerClient: MultiCallerClient;
  profitClient: ProfitClient;
  hubSigner?: Wallet;
}

export function getSpokePoolSigners(baseSigner: Wallet, config: CommonConfig): { [chainId: number]: Wallet } {
  return Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      return [chainId, baseSigner.connect(getProvider(chainId, config.nodeQuorumThreshold))];
    })
  );
}

export async function constructSpokePoolClientsForBlockAndUpdate(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  clients: DataworkerClients,
  logger: winston.Logger,
  latestMainnetBlock: number
): Promise<{ [chainId: number]: SpokePoolClient }> {
  const spokePoolClients = Object.fromEntries(
    chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
      const spokePoolContract = new Contract(
        clients.hubPoolClient.getSpokePoolForBlock(latestMainnetBlock, Number(chainId)),
        SpokePool.abi,
        clients.spokePoolSigners[chainId]
      );
      const client = new SpokePoolClient(
        logger,
        spokePoolContract,
        clients.configStoreClient,
        Number(chainId),
        clients.spokePoolClientSearchSettings[chainId],
        clients.spokePoolClientSearchSettings[chainId].fromBlock
      );
      return [chainId, client];
    })
  );
  await updateSpokePoolClients(spokePoolClients);
  return spokePoolClients;
}

export async function updateSpokePoolClients(spokePoolClients: { [chainId: number]: SpokePoolClient }) {
  await Promise.all(Object.values(spokePoolClients).map((client: SpokePoolClient) => client.update()));
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
    toBlock: null, // Important that we set this to `null` to always look up latest HubPool events such as
    // ProposeRootBundle in order to match a bundle block evaluation block range with a pending root bundle.
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };
  const hubPoolClient = new HubPoolClient(logger, hubPool, hubPoolClientSearchSettings);

  const rateModelClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("AcrossConfigStore", config.hubPoolChainId)),
    toBlock: null,
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };

  let redisClient: ReturnType<typeof createClient> | undefined;
  if (config.redisUrl) {
    redisClient = createClient({
      url: config.redisUrl,
    });
    await redisClient.connect();
    logger.debug({
      at: "Dataworker#ClientHelper",
      message: `Connected to redis server at ${config.redisUrl} successfully!`,
      dbSize: await redisClient.dbSize(),
    });
  }

  const configStoreClient = new AcrossConfigStoreClient(
    logger,
    configStore,
    hubPoolClient,
    rateModelClientSearchSettings,
    redisClient
  );

  // const gasEstimator = new GasEstimator() // todo when this is implemented in the SDK.
  const multiCallerClient = new MultiCallerClient(logger, null, config.maxTxWait);

  const profitClient = new ProfitClient(logger, hubPoolClient);

  return { hubPoolClient, configStoreClient, multiCallerClient, profitClient, hubSigner };
}

export async function updateClients(clients: Clients) {
  await Promise.all([clients.hubPoolClient.update(), clients.configStoreClient.update()]);
  // Must come after hubPoolClient. // TODO: this should be refactored to check if the hubpool client has had one 
  // previous update run such that it has l1 tokens within it.If it has we dont need to make it sequential like this.
  await clients.profitClient.update();
}
