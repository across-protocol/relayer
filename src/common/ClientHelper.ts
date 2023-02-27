import winston from "winston";
import {
  getProvider,
  getDeployedContract,
  getDeploymentBlockNumber,
  Wallet,
  Contract,
  getDeployedBlockNumber,
  getBlockForTimestamp,
  Block,
  getCurrentTime,
  getRedis,
} from "../utils";
import { HubPoolClient, MultiCallerClient, AcrossConfigStoreClient, SpokePoolClient } from "../clients";
import { CommonConfig } from "./Config";
import { SpokePoolClientsByChain } from "../interfaces";
import { BlockFinder } from "@uma/financial-templates-lib";

export interface Clients {
  hubPoolClient: HubPoolClient;
  configStoreClient: AcrossConfigStoreClient;
  multiCallerClient: MultiCallerClient;
  hubSigner?: Wallet;
}

export async function getSpokePoolSigners(
  baseSigner: Wallet,
  config: CommonConfig
): Promise<{ [chainId: number]: Wallet }> {
  const redisClient = config.redisUrl ? await getRedis(config.redisUrl) : undefined;
  return Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      return [chainId, baseSigner.connect(getProvider(chainId, undefined, redisClient))];
    })
  );
}

export async function constructSpokePoolClientsWithLookback(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  baseSigner: Wallet,
  initialLookBackOverride: number,
  hubPoolChainId: number,
  includeDisabledChains = false
): Promise<SpokePoolClientsByChain> {
  const disabledChains = includeDisabledChains ? [] : [288]; // configStoreClient.getDisabledChainsForTimestamp()
  const configWithDisabledChains = {
    ...config,
    spokePoolChains: config.spokePoolChains.filter((chainId) => !disabledChains.includes(chainId)),
  };
  if (disabledChains.length > 0)
    logger.debug({
      at: "ClientHelper#constructSpokePoolClientsWithLookback",
      message: "Disabled chains listed in config store",
      disabledChains,
    });

  // Set up Spoke signers and connect them to spoke pool contract objects:
  const spokePoolSigners = await getSpokePoolSigners(baseSigner, configWithDisabledChains);
  const spokePools = configWithDisabledChains.spokePoolChains.map((chainId) => {
    return { chainId, contract: getDeployedContract("SpokePool", chainId, spokePoolSigners[chainId]) };
  });
  const blockFinders = Object.fromEntries(
    spokePools.map((obj) => {
      if (obj.chainId === hubPoolChainId) return [hubPoolChainId, configStoreClient.blockFinder];
      else
        return [
          obj.chainId,
          new BlockFinder<Block>(obj.contract.provider.getBlock.bind(obj.contract.provider), [], obj.chainId),
        ];
    })
  );
  const currentTime = getCurrentTime();

  const fromBlocks = Object.fromEntries(
    await Promise.all(
      initialLookBackOverride > 0
        ? spokePools.map(async (obj) => {
            return [
              obj.chainId,
              await getBlockForTimestamp(
                hubPoolChainId,
                obj.chainId,
                currentTime - initialLookBackOverride,
                currentTime,
                blockFinders[obj.chainId],
                configStoreClient.redisClient
              ),
            ];
          })
        : spokePools.map(async (obj) => [obj.chainId, await getDeployedBlockNumber("SpokePool", obj.chainId)])
    )
  );

  return getSpokePoolClientsForContract(logger, configStoreClient, config, spokePools, fromBlocks);
}

export function getSpokePoolClientsForContract(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  spokePools: { chainId: number; contract: Contract }[],
  fromBlocks: { [chainId: number]: number },
  toBlocks: { [chainId: number]: number } = {}
): SpokePoolClientsByChain {
  const spokePoolClients: SpokePoolClientsByChain = {};
  spokePools.forEach(({ chainId, contract }) => {
    const spokePoolDeploymentBlock = getDeploymentBlockNumber("SpokePool", chainId);
    const spokePoolClientSearchSettings = {
      fromBlock: fromBlocks[chainId]
        ? Math.max(fromBlocks[chainId], spokePoolDeploymentBlock)
        : spokePoolDeploymentBlock,
      toBlock: toBlocks[chainId] ? toBlocks[chainId] : undefined,
      maxBlockLookBack: config.maxBlockLookBack[chainId],
    };
    spokePoolClients[chainId] = new SpokePoolClient(
      logger,
      contract,
      configStoreClient,
      chainId,
      spokePoolClientSearchSettings,
      spokePoolDeploymentBlock
    );
  });

  return spokePoolClients;
}

export async function updateSpokePoolClients(
  spokePoolClients: { [chainId: number]: SpokePoolClient },
  eventsToQuery?: string[]
): Promise<void> {
  await Promise.all(Object.values(spokePoolClients).map((client: SpokePoolClient) => client.update(eventsToQuery)));
}

export async function constructClients(
  logger: winston.Logger,
  config: CommonConfig,
  baseSigner: Wallet
): Promise<Clients> {
  const redisClient = config.redisUrl ? await getRedis(config.redisUrl) : undefined;

  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId, logger, redisClient));

  // Create contract instances for each chain for each required contract.
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);

  const configStore = getDeployedContract("AcrossConfigStore", config.hubPoolChainId, hubSigner);

  const hubPoolClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("HubPool", config.hubPoolChainId)),
    toBlock: undefined, // Important that we set this to `undefined` to always look up latest HubPool events such as
    // ProposeRootBundle in order to match a bundle block evaluation block range with a pending root bundle.
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };
  const hubPoolClient = new HubPoolClient(logger, hubPool, config.hubPoolChainId, hubPoolClientSearchSettings);

  const rateModelClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("AcrossConfigStore", config.hubPoolChainId)),
    toBlock: undefined,
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };

  const configStoreClient = new AcrossConfigStoreClient(
    logger,
    configStore,
    hubPoolClient,
    rateModelClientSearchSettings,
    redisClient
  );

  const multiCallerClient = new MultiCallerClient(logger, config.multiCallChunkSize);

  return { hubPoolClient, configStoreClient, multiCallerClient, hubSigner };
}

export async function updateClients(clients: Clients) {
  await Promise.all([clients.hubPoolClient.update(), clients.configStoreClient.update()]);
}
