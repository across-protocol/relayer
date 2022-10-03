import winston from "winston";
import {
  getProvider,
  getDeployedContract,
  getDeploymentBlockNumber,
  Wallet,
  Contract,
  EventSearchConfig,
} from "../utils";
import { HubPoolClient, MultiCallerClient, AcrossConfigStoreClient, SpokePoolClient } from "../clients";
import { CommonConfig } from "./Config";
import { createClient } from "redis4";
import { SpokePoolClientsByChain } from "../interfaces";

export interface Clients {
  hubPoolClient: HubPoolClient;
  configStoreClient: AcrossConfigStoreClient;
  multiCallerClient: MultiCallerClient;
  hubSigner?: Wallet;
}

export function getSpokePoolSigners(baseSigner: Wallet, config: CommonConfig): { [chainId: number]: Wallet } {
  return Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      return [chainId, baseSigner.connect(getProvider(chainId))];
    })
  );
}

export async function constructSpokePoolClientsWithLookback(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  baseSigner: Wallet,
  initialLookBackOverride: { [chainId: number]: number } = {}
): Promise<SpokePoolClientsByChain> {
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
    if (initialLookBackOverride[obj.networkId]) {
      fromBlocks[obj.networkId] = l2BlockNumbers[index] - initialLookBackOverride[obj.networkId];
    }
  });

  return getSpokePoolClientsForContract(logger, configStoreClient, config, spokePools, fromBlocks);
}

function getSpokePoolClientsForContract(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  spokePools: { networkId: number; contract: Contract }[],
  fromBlocks: { [networkId: number]: number },
  toBlocks?: { [networkId: number]: number }
): SpokePoolClientsByChain {
  const spokePoolClients: SpokePoolClientsByChain = {};
  spokePools.forEach(({ networkId, contract }) => {
    const spokePoolDeploymentBlock = getDeploymentBlockNumber("SpokePool", networkId);
    const spokePoolClientSearchSettings = {
      fromBlock: fromBlocks[networkId]
        ? Math.max(fromBlocks[networkId], spokePoolDeploymentBlock)
        : spokePoolDeploymentBlock,
      toBlock: toBlocks[networkId] ? toBlocks[networkId] : null,
      maxBlockLookBack: config.maxBlockLookBack[networkId],
    };
    spokePoolClients[networkId] = new SpokePoolClient(
      logger,
      contract,
      configStoreClient,
      networkId,
      spokePoolClientSearchSettings,
      spokePoolDeploymentBlock
    );
  });

  return spokePoolClients;
}

export async function constructSpokePoolClientsWithStartBlocks(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  baseSigner: Wallet,
  startBlockOverride: { [chainId: number]: number } = {},
  toBlockOverride: { [chainId: number]: number } = {}
): Promise<SpokePoolClientsByChain> {
  // Set up Spoke signers and connect them to spoke pool contract objects:
  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);
  const spokePools = config.spokePoolChains.map((networkId) => {
    return { networkId, contract: getDeployedContract("SpokePool", networkId, spokePoolSigners[networkId]) };
  });

  // If no lookback is set, fromBlock will be set to spoke pool's deployment block.
  const fromBlocks = {};
  spokePools.forEach((obj: { networkId: number; contract: Contract }) => {
    if (startBlockOverride[obj.networkId]) {
      fromBlocks[obj.networkId] = startBlockOverride[obj.networkId];
    }
  });

  return getSpokePoolClientsForContract(logger, configStoreClient, config, spokePools, fromBlocks, toBlockOverride);
}

export async function updateSpokePoolClients(
  spokePoolClients: { [chainId: number]: SpokePoolClient },
  eventsToQuery?: string[],
  latestFullyExecutedBundleEndBlocks: { [chainId: number]: number } = {}
) {
  await Promise.all(
    Object.values(spokePoolClients).map((client: SpokePoolClient) =>
      client.update(eventsToQuery, latestFullyExecutedBundleEndBlocks[client.chainId])
    )
  );
}

export async function constructSpokePoolClientsWithStartBlocksAndUpdate(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  baseSigner: Wallet,
  startBlockOverride: { [chainId: number]: number } = {},
  endBlockOverride: { [chainId: number]: number } = {},
  eventsToQuery?: string[],
  latestFullyExecutedBundleEndBlocks: { [chainId: number]: number } = {}
) {
  const spokePoolClients = await constructSpokePoolClientsWithStartBlocks(
    logger,
    configStoreClient,
    config,
    baseSigner,
    startBlockOverride,
    endBlockOverride
  );
  await updateSpokePoolClients(spokePoolClients, eventsToQuery, latestFullyExecutedBundleEndBlocks);
  return spokePoolClients;
}

export async function constructClients(
  logger: winston.Logger,
  config: CommonConfig,
  baseSigner: Wallet
): Promise<Clients> {
  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId, logger));

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

  const multiCallerClient = new MultiCallerClient(logger);

  return { hubPoolClient, configStoreClient, multiCallerClient, hubSigner };
}

export async function updateClients(clients: Clients) {
  await Promise.all([clients.hubPoolClient.update(), clients.configStoreClient.update()]);
}
