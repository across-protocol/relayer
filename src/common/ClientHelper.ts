import winston from "winston";
import {
  getProvider,
  getDeployedContract,
  getDeploymentBlockNumber,
  Wallet,
  Contract,
  ethers,
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
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  baseSigner: Wallet,
  initialLookBackOverride: number,
  hubPoolChainId: number
): Promise<SpokePoolClientsByChain> {
  // Create blockfinders for each chain. We'll use the latter to find the first
  // blocks that we should query per chain.
  const blockFinders = Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      const providerForChain = getProvider(chainId);
      if (chainId === hubPoolChainId) return [hubPoolChainId, configStoreClient.blockFinder];
      else return [chainId, new BlockFinder<Block>(providerForChain.getBlock.bind(providerForChain), [], chainId)];
    })
  );
  const currentTime = getCurrentTime();

  const fromBlocks = Object.fromEntries(
    await Promise.all(
      config.spokePoolChains.map(async (chainId) => {
        return [
          chainId,
          await getBlockForTimestamp(
            hubPoolChainId,
            chainId,
            currentTime - initialLookBackOverride,
            currentTime,
            blockFinders[chainId],
            configStoreClient.redisClient
          ),
        ];
      })
    )
  );

  // @dev: Set toBlocks = {} to construct spoke pool clients that query until the latest blocks.
  return await constructSpokePoolClientsWithStartBlocks(logger, configStoreClient, config, baseSigner, fromBlocks, {});
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
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  baseSigner: Wallet,
  startBlockOverride: { [chainId: number]: number } = {},
  toBlockOverride: { [chainId: number]: number } = {}
): Promise<SpokePoolClientsByChain> {
  // By default, construct spoke clients for all chains that are not disabled at the time of the first block that we'll
  // query. This does not handle the case where a chain was disabled at the start block and later un-disabled, but
  // this case is very rare. This is a good solution for handling the case where a chain is disabled and we want to
  // eventually stop sending RPC requests for it, but we might need to reconstruct bundles (for the executor) for
  // a while even after we disable it.

  // Caller can optionally override the disabled chains list, which is useful for executing leaves or validating
  // older bundles, or monitoring older bundles. This is a useful override for handling the aforementioned rare case
  // where a chain is disabled and then reenabled. The Caller should be careful when setting when
  // running the disputer or proposer functionality as it can lead to proposing disputable bundles or
  // disputing valid bundles.

  // Note: it's ok if startBlockOverride[1] is undefined, in that case we'll use the latest mainnet block
  // as input into `getDisabledChainsForBlock`
  const disabledChains =
    config.disabledChainsOverride.length > 0
      ? config.disabledChainsOverride
      : configStoreClient.getDisabledChainsForBlock(startBlockOverride[1]);

  // In no cases do we want to override the disabled chain list for Dataworker functions. If we want to reconstruct
  // and older bundle, then the `startBlockOverride`-`toBlockOverride` should cover that older bundle's range,
  // and in that case if the chain was enabled at `startBlockOverride` then we will construct a spoke client
  // for it.
  const configWithDisabledChains = {
    ...config,
    spokePoolChains: config.spokePoolChains.filter((chainId) => !disabledChains.includes(chainId)),
  };
  if (disabledChains.length > 0)
    logger.debug({
      at: "DataworkerClientHelper#constructSpokePoolClientsWithStartBlocks",
      message: "Disabling constructing spoke pool clients for chains",
      disabledChains,
    });

  // Set up Spoke signers and connect them to spoke pool contract objects:
  const spokePoolSigners = await getSpokePoolSigners(baseSigner, configWithDisabledChains);
  const spokePools = configWithDisabledChains.spokePoolChains.map((chainId) => {
    return { chainId, contract: getDeployedContract("SpokePool", chainId, spokePoolSigners[chainId]) };
  });

  // If no lookback is set, fromBlock will be set to spoke pool's deployment block.
  const fromBlocks: { [chainId: number]: number } = {};
  spokePools.forEach((obj: { chainId: number; contract: Contract }) => {
    if (startBlockOverride[obj.chainId]) {
      fromBlocks[obj.chainId] = startBlockOverride[obj.chainId];
    }
  });

  return getSpokePoolClientsForContract(
    logger,
    configStoreClient,
    configWithDisabledChains,
    spokePools,
    fromBlocks,
    toBlockOverride
  );
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

export function spokePoolClientsToProviders(spokePoolClients: { [chainId: number]: SpokePoolClient }): {
  [chainId: number]: ethers.providers.Provider;
} {
  return Object.fromEntries(
    Object.entries(spokePoolClients).map(([chainId, client]) => [Number(chainId), client.spokePool.signer.provider!])
  );
}
