import winston from "winston";
import {
  getProvider,
  getDeployedContract,
  getDeploymentBlockNumber,
  Wallet,
  Contract,
  ethers,
  getBlockForTimestamp,
  getCurrentTime,
  SpokePool,
  isDefined,
  getRedisCache,
} from "../utils";
import { HubPoolClient, MultiCallerClient, ConfigStoreClient, SpokePoolClient } from "../clients";
import { CommonConfig } from "./Config";
import { SpokePoolClientsByChain } from "../interfaces";
import { clients } from "@across-protocol/sdk-v2";

export interface Clients {
  hubPoolClient: HubPoolClient;
  configStoreClient: ConfigStoreClient;
  multiCallerClient: MultiCallerClient;
  hubSigner?: Wallet;
}

async function getSpokePoolSigners(
  baseSigner: Wallet,
  spokePoolChains: number[]
): Promise<{ [chainId: number]: Wallet }> {
  return Object.fromEntries(
    await Promise.all(
      spokePoolChains.map(async (chainId) => {
        return [chainId, baseSigner.connect(await getProvider(chainId, undefined))];
      })
    )
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
  hubPoolClient: HubPoolClient,
  configStoreClient: ConfigStoreClient,
  config: CommonConfig,
  baseSigner: Wallet,
  initialLookBackOverride: number
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
  const currentTime = getCurrentTime();

  // Use the first block that we'll query on mainnet to figure out which chains were enabled between then
  // and the the latest mainnet block. These chains were enabled via the ConfigStore.
  const fromBlock_1 = await getBlockForTimestamp(hubPoolChainId, currentTime - initialLookBackOverride);
  const enabledChains = getEnabledChainsInBlockRange(configStoreClient, config.spokePoolChainsOverride, fromBlock_1);

  // Get full list of fromBlocks now for chains that are enabled. This way we don't send RPC requests to
  // chains that are not enabled.
  const fromBlocks = Object.fromEntries(
    await Promise.all(
      enabledChains.map(async (chainId) => {
        if (chainId === 1) {
          return [chainId, fromBlock_1];
        } else {
          return [chainId, await getBlockForTimestamp(chainId, currentTime - initialLookBackOverride)];
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
  baseSigner: Wallet,
  startBlocks: { [chainId: number]: number },
  toBlockOverride: { [chainId: number]: number } = {},
  enabledChains?: number[]
): Promise<SpokePoolClientsByChain> {
  if (!enabledChains) {
    enabledChains = getEnabledChainsInBlockRange(
      hubPoolClient.configStoreClient,
      config.spokePoolChainsOverride,
      startBlocks[hubPoolClient.chainId],
      toBlockOverride[hubPoolClient.chainId]
    );
  }

  logger.debug({
    at: "ClientHelper#constructSpokePoolClientsWithStartBlocks",
    message: "Enabled chains in block range",
    startBlocks,
    toBlockOverride,
    enabledChains,
  });

  // Set up Spoke signers and connect them to spoke pool contract objects:
  const spokePoolSigners = await getSpokePoolSigners(baseSigner, enabledChains);
  const spokePools = await Promise.all(
    enabledChains.map(async (chainId) => {
      // Grab latest spoke pool as of `toBlockOverride[1]`. If `toBlockOverride[1]` is undefined, then grabs current
      // spoke pool.
      const latestSpokePool = hubPoolClient.getSpokePoolForBlock(chainId, toBlockOverride[1]);
      const spokePoolContract = new Contract(latestSpokePool, SpokePool.abi, spokePoolSigners[chainId]);
      const spokePoolRegistrationBlock = hubPoolClient.getSpokePoolActivationBlock(chainId, latestSpokePool);
      const time = (await hubPoolClient.hubPool.provider.getBlock(spokePoolRegistrationBlock)).timestamp;
      const registrationBlock = await getBlockForTimestamp(chainId, time);
      return { chainId, contract: spokePoolContract, registrationBlock };
    })
  );

  return getSpokePoolClientsForContract(logger, hubPoolClient, config, spokePools, startBlocks, toBlockOverride);
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
  toBlocks: { [chainId: number]: number } = {}
): SpokePoolClientsByChain {
  const spokePoolClients: SpokePoolClientsByChain = {};
  spokePools.forEach(({ chainId, contract, registrationBlock }) => {
    if (!isDefined(fromBlocks[chainId])) {
      logger.debug({
        at: "ClientHelper#getSpokePoolClientsForContract",
        message: `No fromBlock set for spoke pool client ${chainId}, setting from block to registration block`,
        registrationBlock,
      });
    }
    const spokePoolClientSearchSettings = {
      fromBlock: fromBlocks[chainId] ? Math.max(fromBlocks[chainId], registrationBlock) : registrationBlock,
      toBlock: toBlocks[chainId] ? toBlocks[chainId] : undefined,
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
  baseSigner: Wallet
): Promise<Clients> {
  const hubSigner = baseSigner.connect(await getProvider(config.hubPoolChainId, logger));

  const rateModelClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("AcrossConfigStore", config.hubPoolChainId)),
    toBlock: undefined,
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };

  const configStore = getDeployedContract("AcrossConfigStore", config.hubPoolChainId, hubSigner);
  const configStoreClient = new ConfigStoreClient(
    logger,
    configStore,
    rateModelClientSearchSettings,
    config.maxConfigVersion
  );

  const hubPoolClientSearchSettings = {
    fromBlock: Number(getDeploymentBlockNumber("HubPool", config.hubPoolChainId)),
    toBlock: undefined, // Important that we set this to `undefined` to always look up latest HubPool events such as
    // ProposeRootBundle in order to match a bundle block evaluation block range with a pending root bundle.
    maxBlockLookBack: config.maxBlockLookBack[config.hubPoolChainId],
  };

  // Create contract instances for each chain for each required contract.
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);
  const hubPoolClient = new HubPoolClient(
    logger,
    hubPool,
    configStoreClient,
    Number(getDeploymentBlockNumber("HubPool", config.hubPoolChainId)),
    config.hubPoolChainId,
    hubPoolClientSearchSettings,
    await getRedisCache(logger)
  );

  const multiCallerClient = new MultiCallerClient(logger, config.multiCallChunkSize, hubSigner);

  return { hubPoolClient, configStoreClient, multiCallerClient, hubSigner };
}

// @dev The HubPoolClient is dependent on the state of the ConfigStoreClient,
//      so update the ConfigStoreClient first.
export async function updateClients(clients: Clients, config: CommonConfig): Promise<void> {
  await clients.configStoreClient.update();
  config.loadAndValidateConfigForChains(clients.configStoreClient.getChainIdIndicesForBlock());
  await clients.hubPoolClient.update();
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
