import assert from "assert";
import winston from "winston";
import {
  getProvider,
  getDeployedContract,
  getDeploymentBlockNumber,
  Signer,
  Contract,
  ethers,
  getBlockForTimestamp,
  getCurrentTime,
  SpokePool,
  isDefined,
  getRedisCache,
  getArweaveJWKSigner,
} from "../utils";
import { HubPoolClient, MultiCallerClient, ConfigStoreClient, SpokePoolClient } from "../clients";
import { CommonConfig } from "./Config";
import { SpokePoolClientsByChain } from "../interfaces";
import { caching, clients, utils as sdkUtils } from "@across-protocol/sdk";
import V3_SPOKE_POOL_ABI from "./abi/V3SpokePool.json";

export interface Clients {
  hubPoolClient: HubPoolClient;
  configStoreClient: ConfigStoreClient;
  multiCallerClient: MultiCallerClient;
  hubSigner?: Signer;
  arweaveClient: caching.ArweaveClient;
}

async function getSpokePoolSigners(
  baseSigner: Signer,
  spokePoolChains: number[]
): Promise<{ [chainId: number]: Signer }> {
  return Object.fromEntries(
    await Promise.all(
      spokePoolChains.map(async (chainId) => {
        return [chainId, baseSigner.connect(await getProvider(chainId, undefined))];
      })
    )
  );
}

/**
 * Resolve the spoke chain activation block for a SpokePool deployment. Prefer sourcing the
 * block number from cache, but fall back to resolution via RPC queries and cache the result.
 * @param chainId Chain ID for the SpokePool deployment.
 * @param hubPoolClient HubPoolClient instance.
 * @returns SpokePool activation block number on chainId.
 */
export async function resolveSpokePoolActivationBlock(
  chainId: number,
  hubPoolClient: HubPoolClient,
  blockNumber?: number
): Promise<number> {
  const spokePoolAddr = hubPoolClient.getSpokePoolForBlock(chainId, blockNumber);
  const key = `relayer_${chainId}_spokepool_${spokePoolAddr}_activation_block`;

  const redis = await getRedisCache(hubPoolClient.logger);
  if (isDefined(redis)) {
    const activationBlock = await redis.get(key);
    const numericActivationBlock = Number(activationBlock);
    if (Number.isInteger(numericActivationBlock) && numericActivationBlock > 0) {
      return numericActivationBlock;
    }
  }

  // Get the timestamp of the block where the SpokePool was activated on mainnet, and resolve that
  // to a block number on the SpokePool chain. Use this block as the lower bound for the search.
  const blockFinder = undefined;
  const mainnetActivationBlock = hubPoolClient.getSpokePoolActivationBlock(chainId, spokePoolAddr);
  const { timestamp } = await hubPoolClient.hubPool.provider.getBlock(mainnetActivationBlock);
  const hints = { lowBlock: getDeploymentBlockNumber("SpokePool", chainId) };
  const activationBlock = await getBlockForTimestamp(chainId, timestamp, blockFinder, redis, hints);

  const cacheAfter = 5 * 24 * 3600; // 5 days
  if (isDefined(redis) && getCurrentTime() - timestamp > cacheAfter) {
    await redis.set(key, activationBlock.toString());
  }

  return activationBlock;
}

/**
 * Construct spoke pool clients that query from [latest-lookback, latest]. Clients on chains that are disabled at
 * latest-lookback will be set to undefined.
 * @param baseSigner Signer to set for spoke pool contracts.
 * @param initialLookBackOverride How far to lookback per chain. Specified in seconds.
 * @param hubPoolChainId Mainnet chain ID.
 * @returns Mapping of chainId to SpokePoolClient
 */
export async function constructSpokePoolClientsWithLookback(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  configStoreClient: ConfigStoreClient,
  config: CommonConfig,
  baseSigner: Signer,
  initialLookBackOverride: number,
  enabledChains?: number[]
): Promise<SpokePoolClientsByChain> {
  // Construct spoke pool clients for all chains that were enabled at least once in the block range.
  // Caller can optionally override the disabled chains list, which is useful for executing leaves or validating
  // older bundles, or monitoring older bundles. The Caller should be careful when setting when
  // running the disputer or proposer functionality as it can lead to proposing disputable bundles or
  // disputing valid bundles.

  if (!hubPoolClient.isUpdated) {
    throw new Error("Config store client must be updated before constructing spoke pool clients");
  }

  const hubPoolChainId = hubPoolClient.chainId;
  const lookback = getCurrentTime() - initialLookBackOverride;

  // Use the first block that we'll query on mainnet to figure out which chains were enabled between then and the latest
  // mainnet block. These chains were enabled via the ConfigStore. These lookbacks should typically be fairly short, so
  // BlockFinder estimates are likely to be OK - avoid overriding them with hints.
  const blockFinder = undefined;
  const redis = await getRedisCache(logger);
  const fromBlock_1 = await getBlockForTimestamp(hubPoolChainId, lookback, blockFinder, redis);
  enabledChains ??= getEnabledChainsInBlockRange(configStoreClient, config.spokePoolChainsOverride, fromBlock_1);
  assert(enabledChains.length > 0, "No SpokePool chains configured");

  // Get full list of fromBlocks now for chains that are enabled. This way we don't send RPC requests to
  // chains that are not enabled.
  const fromBlocks = Object.fromEntries(
    await Promise.all(
      enabledChains.map(async (chainId) => {
        if (chainId === hubPoolChainId) {
          return [chainId, fromBlock_1];
        } else {
          return [chainId, await getBlockForTimestamp(chainId, lookback, blockFinder, redis)];
        }
      })
    )
  );

  // @dev: If toBlocks = {} then  construct spoke pool clients that query until the latest blocks.
  return await constructSpokePoolClientsWithStartBlocks(
    logger,
    hubPoolClient,
    config,
    baseSigner,
    fromBlocks,
    config.toBlockOverride,
    enabledChains
  );
}

/**
 * @notice Return list of enabled spoke pool chains in mainnet block range. These chains were all enabled at some point
 * in the ConfigStore between [mainnetStartBlock, mainnetEndBlock]. Caller can override this list with
 * process.env.SPOKE_POOL_CHAINS_OVERRIDE to force certain spoke pool clients to be constructed.
 * @returns number[] List of enabled spoke pool chains.
 */
function getEnabledChainsInBlockRange(
  configStoreClient: clients.AcrossConfigStoreClient,
  spokePoolChainsOverride: number[],
  mainnetStartBlock: number,
  mainnetEndBlock?: number
): number[] {
  if (!configStoreClient.isUpdated) {
    throw new Error("Config store client must be updated before constructing spoke pool clients");
  }
  return spokePoolChainsOverride.length > 0
    ? spokePoolChainsOverride
    : configStoreClient.getEnabledChainsInBlockRange(mainnetStartBlock, mainnetEndBlock);
}
/**
 * Construct spoke pool clients that query from [startBlockOverride, toBlockOverride]. Clients on chains that are
 * disabled at startBlockOverride will be set to undefined.
 * @param baseSigner Signer to set for spoke pool contracts.
 * @param startBlockOverride Mapping of chainId to from Blocks per chain to set in SpokePoolClients.
 * @param toBlockOverride Mapping of chainId to toBlocks per chain to set in SpokePoolClients.
 * @returns Mapping of chainId to SpokePoolClient
 */
export async function constructSpokePoolClientsWithStartBlocks(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  config: CommonConfig,
  baseSigner: Signer,
  startBlocks: { [chainId: number]: number },
  toBlockOverride: { [chainId: number]: number } = {},
  enabledChains?: number[]
): Promise<SpokePoolClientsByChain> {
  enabledChains ??= getEnabledChainsInBlockRange(
    hubPoolClient.configStoreClient,
    config.spokePoolChainsOverride,
    startBlocks[hubPoolClient.chainId],
    toBlockOverride[hubPoolClient.chainId]
  );

  logger.debug({
    at: "ClientHelper#constructSpokePoolClientsWithStartBlocks",
    message: "Enabled chains in block range",
    startBlocks,
    toBlockOverride,
    enabledChains,
  });

  const blockFinder = undefined;
  const redis = await getRedisCache(logger);

  // Set up Spoke signers and connect them to spoke pool contract objects:
  const spokePoolSigners = await getSpokePoolSigners(baseSigner, enabledChains);
  const spokePools = await Promise.all(
    enabledChains.map(async (chainId) => {
      const spokePoolAddr = hubPoolClient.getSpokePoolForBlock(chainId, toBlockOverride[1]);
      // TODO: initialize using typechain factory after V3.5 migration.
      // const spokePoolContract = SpokePool.connect(spokePoolAddr, spokePoolSigners[chainId]);
      const spokePoolContract = new ethers.Contract(
        spokePoolAddr,
        [...SpokePool.abi, ...V3_SPOKE_POOL_ABI],
        spokePoolSigners[chainId]
      );
      const registrationBlock = await resolveSpokePoolActivationBlock(chainId, hubPoolClient, toBlockOverride[1]);
      return { chainId, contract: spokePoolContract, registrationBlock };
    })
  );

  // Explicitly set toBlocks for all chains so we can re-use them in other clients to make sure they all query
  // state to the same "latest" block per chain.
  const hubPoolBlock = await hubPoolClient.hubPool.provider.getBlock(hubPoolClient.latestBlockSearched);
  const latestBlocksForChain: Record<number, number> = Object.fromEntries(
    await Promise.all(
      enabledChains.map(async (chainId) => {
        // Allow caller to hardcode the spoke pool client end blocks.
        if (isDefined(toBlockOverride[chainId])) {
          return [chainId, toBlockOverride[chainId]];
        }
        if (chainId === hubPoolClient.chainId) {
          return [chainId, hubPoolBlock.number];
        } else {
          const toBlock = await getBlockForTimestamp(chainId, hubPoolBlock.timestamp, blockFinder, redis);
          return [chainId, toBlock];
        }
      })
    )
  );

  return getSpokePoolClientsForContract(logger, hubPoolClient, config, spokePools, startBlocks, latestBlocksForChain);
}

/**
 * Constructs spoke pool clients using input configurations.
 * @param spokePools Creates a client for each spoke pool in this mapping of chainId to contract.
 * @param fromBlocks Mapping of chainId to fromBlocks per chain to set in SpokePoolClients.
 * @param toBlocks Mapping of chainId to toBlocks per chain to set in SpokePoolClients.
 * @returns Mapping of chainId to SpokePoolClient
 */
export function getSpokePoolClientsForContract(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  config: CommonConfig,
  spokePools: { chainId: number; contract: Contract; registrationBlock: number }[],
  fromBlocks: { [chainId: number]: number },
  toBlocks: { [chainId: number]: number }
): SpokePoolClientsByChain {
  logger.debug({
    at: "ClientHelper#getSpokePoolClientsForContract",
    message: "Constructing SpokePoolClients",
    fromBlocks,
    toBlocks,
  });

  const spokePoolClients: SpokePoolClientsByChain = {};
  spokePools.forEach(({ chainId, contract, registrationBlock }) => {
    if (!isDefined(fromBlocks[chainId])) {
      logger.debug({
        at: "ClientHelper#getSpokePoolClientsForContract",
        message: `No fromBlock set for spoke pool client ${chainId}, setting from block to registration block`,
        registrationBlock,
      });
    }
    if (!isDefined(toBlocks[chainId])) {
      logger.debug({
        at: "ClientHelper#getSpokePoolClientsForContract",
        message: `No toBlock set for spoke pool client ${chainId}, exiting since this can lead to state sync issues between clients querying "latest" state from this chain`,
      });
    }
    const spokePoolClientSearchSettings = {
      fromBlock: fromBlocks[chainId] ? Math.max(fromBlocks[chainId], registrationBlock) : registrationBlock,
      toBlock: toBlocks[chainId],
      maxBlockLookBack: config.maxBlockLookBack[chainId],
    };
    spokePoolClients[chainId] = new SpokePoolClient(
      logger,
      contract,
      hubPoolClient,
      chainId,
      registrationBlock,
      spokePoolClientSearchSettings
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
  baseSigner: Signer,
  hubPoolLookback?: number
): Promise<Clients> {
  const hubPoolProvider = await getProvider(config.hubPoolChainId, logger);
  const hubSigner = baseSigner.connect(hubPoolProvider);
  const latestMainnetBlock = await hubPoolProvider.getBlockNumber();

  const rateModelClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("AcrossConfigStore", config.hubPoolChainId)),
    toBlock: config.toBlockOverride[config.hubPoolChainId] ?? latestMainnetBlock,
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };

  const configStore = getDeployedContract("AcrossConfigStore", config.hubPoolChainId, hubSigner);
  const configStoreClient = new ConfigStoreClient(
    logger,
    configStore,
    rateModelClientSearchSettings,
    config.maxConfigVersion
  );

  const hubPoolDeploymentBlock = Number(getDeploymentBlockNumber("HubPool", config.hubPoolChainId));
  const { average: avgMainnetBlockTime } = await sdkUtils.averageBlockTime(hubPoolProvider);
  const fromBlock = isDefined(hubPoolLookback)
    ? Math.max(latestMainnetBlock - hubPoolLookback / avgMainnetBlockTime, hubPoolDeploymentBlock)
    : hubPoolDeploymentBlock;
  const hubPoolClientSearchSettings = { ...rateModelClientSearchSettings, fromBlock };

  // Create contract instances for each chain for each required contract.
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);
  const hubPoolClient = new HubPoolClient(
    logger,
    hubPool,
    configStoreClient,
    hubPoolDeploymentBlock,
    config.hubPoolChainId,
    hubPoolClientSearchSettings,
    await getRedisCache(logger),
    config.timeToCache
  );

  const multiCallerClient = new MultiCallerClient(logger, config.multiCallChunkSize, hubSigner);

  // Define the Arweave client as "read-only" to prevent any accidental writes to the Arweave network.
  // Only the dataworker should have write access to the Arweave network - we will define that in
  // the more specialized dataworker client helper.
  const arweaveClient = new caching.ArweaveClient(
    getArweaveJWKSigner({ keyType: "read-only" }),
    logger,
    config.arweaveGateway?.url,
    config.arweaveGateway?.protocol,
    config.arweaveGateway?.port
  );

  return { hubPoolClient, configStoreClient, multiCallerClient, hubSigner, arweaveClient };
}

// @dev The HubPoolClient is dependent on the state of the ConfigStoreClient,
//      so update the ConfigStoreClient first.
export async function updateClients(clients: Clients, config: CommonConfig, logger?: winston.Logger): Promise<void> {
  await clients.configStoreClient.update();
  config.validate(clients.configStoreClient.getChainIdIndicesForBlock(), logger);
}

export function spokePoolClientsToProviders(spokePoolClients: { [chainId: number]: SpokePoolClient }): {
  [chainId: number]: ethers.providers.Provider;
} {
  return Object.fromEntries(
    Object.entries(spokePoolClients)
      .map(([chainId, client]): [number, ethers.providers.Provider] => [
        Number(chainId),
        client.spokePool.signer.provider,
      ])
      .filter(([, provider]) => !!provider)
  );
}
