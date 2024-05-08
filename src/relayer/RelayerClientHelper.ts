import { ChildProcess } from "child_process";
import { Contract } from "ethers";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import winston from "winston";
import {
  AcrossApiClient,
  BundleDataClient,
  HubPoolClient,
  InventoryClient,
  ProfitClient,
  IndexedSpokePoolClient,
  TokenClient,
} from "../clients";
import { AdapterManager, CrossChainTransferClient } from "../clients/bridges";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithLookback,
  updateClients,
  updateSpokePoolClients,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import {
  getBlockForTimestamp,
  getDeploymentBlockNumber,
  getProvider,
  getRedisCache,
  Signer,
  SpokePool,
} from "../utils";
import { RelayerConfig } from "./RelayerConfig";

export interface RelayerClients extends Clients {
  spokePoolClients: SpokePoolClientsByChain;
  tokenClient: TokenClient;
  profitClient: ProfitClient;
  inventoryClient: InventoryClient;
  acrossApiClient: AcrossApiClient;
}

async function indexedSpokePoolClient(
  baseSigner: Signer,
  hubPoolClient: HubPoolClient,
  chainId: number,
  worker: ChildProcess
): Promise<IndexedSpokePoolClient> {
  const { logger } = hubPoolClient;

  // Set up Spoke signers and connect them to spoke pool contract objects.
  const signer = baseSigner.connect(await getProvider(chainId));

  const blockFinder = undefined;
  const redis = await getRedisCache(hubPoolClient.logger);

  const spokePoolAddr = hubPoolClient.getSpokePoolForBlock(chainId, hubPoolClient.latestBlockSearched);
  const spokePool = new Contract(spokePoolAddr, SpokePool.abi, signer);
  const spokePoolActivationBlock = hubPoolClient.getSpokePoolActivationBlock(chainId, spokePoolAddr);
  const time = (await hubPoolClient.hubPool.provider.getBlock(spokePoolActivationBlock)).timestamp;

  // Improve BlockFinder efficiency by clamping its search space lower bound to the SpokePool deployment block.
  const hints = { lowBlock: getDeploymentBlockNumber("SpokePool", chainId) };
  const registrationBlock = await getBlockForTimestamp(chainId, time, blockFinder, redis, hints);

  const spokePoolClient = new IndexedSpokePoolClient(
    logger,
    spokePool,
    hubPoolClient,
    chainId,
    registrationBlock,
    worker
  );
  spokePoolClient.init();

  return spokePoolClient;
}

export async function constructRelayerClients(
  logger: winston.Logger,
  config: RelayerConfig,
  baseSigner: Signer,
  workers: { [chainId: number]: ChildProcess }
): Promise<RelayerClients> {
  const signerAddr = await baseSigner.getAddress();
  // The relayer only uses the HubPoolClient to query repayments refunds for the latest validated
  // bundle and the pending bundle. 8 hours should cover the latest two bundles on production in
  // almost all cases. Look back to genesis on testnets.
  const hubPoolLookBack = sdkUtils.chainIsProd(config.hubPoolChainId) ? 3600 * 8 : Number.POSITIVE_INFINITY;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookBack);
  const { configStoreClient, hubPoolClient } = commonClients;
  await updateClients(commonClients, config);
  await hubPoolClient.update();

  // If both origin and destination chains are configured, then limit the SpokePoolClients instantiated to the
  // sum of them. Otherwise, do not specify the chains to be instantiated to inherit one SpokePoolClient per
  // enabled chain.
  const enabledChains =
    config.relayerOriginChains.length > 0 && config.relayerDestinationChains.length > 0
      ? sdkUtils.dedupArray([...config.relayerOriginChains, ...config.relayerDestinationChains])
      : undefined;

  let spokePoolClients: SpokePoolClientsByChain;
  if (config.externalIndexer) {
    spokePoolClients = Object.fromEntries(
      await sdkUtils.mapAsync(enabledChains ?? configStoreClient.getEnabledChains(), async (chainId) => [
        chainId,
        await indexedSpokePoolClient(baseSigner, hubPoolClient, chainId, workers[chainId]),
      ])
    );
  } else {
    spokePoolClients = await constructSpokePoolClientsWithLookback(
      logger,
      hubPoolClient,
      configStoreClient,
      config,
      baseSigner,
      config.maxRelayerLookBack,
      enabledChains
    );
  }

  // Determine which origin chains to query limits for.
  const srcChainIds =
    config.relayerOriginChains.length > 0
      ? config.relayerOriginChains
      : Object.values(spokePoolClients).map(({ chainId }) => chainId);
  const acrossApiClient = new AcrossApiClient(logger, hubPoolClient, srcChainIds, config.relayerTokens);

  const tokenClient = new TokenClient(logger, signerAddr, spokePoolClients, hubPoolClient);

  // If `relayerDestinationChains` is a non-empty array, then copy its value, otherwise default to all chains.
  const enabledChainIds = (
    config.relayerDestinationChains.length > 0
      ? config.relayerDestinationChains
      : configStoreClient.getChainIdIndicesForBlock()
  ).filter((chainId) => Object.keys(spokePoolClients).includes(chainId.toString()));
  const profitClient = new ProfitClient(
    logger,
    hubPoolClient,
    spokePoolClients,
    enabledChainIds,
    signerAddr,
    config.minRelayerFeePct,
    config.debugProfitability,
    config.relayerGasMultiplier,
    config.relayerMessageGasMultiplier,
    config.relayerGasPadding
  );

  const monitoredAddresses = [signerAddr];
  const adapterManager = new AdapterManager(
    logger,
    spokePoolClients,
    hubPoolClient,
    monitoredAddresses.filter(() => sdkUtils.isDefined)
  );

  const bundleDataClient = new BundleDataClient(
    logger,
    commonClients,
    spokePoolClients,
    configStoreClient.getChainIdIndicesForBlock(),
    config.blockRangeEndBlockBuffer
  );

  const crossChainAdapterSupportedChains = adapterManager.supportedChains();
  const crossChainTransferClient = new CrossChainTransferClient(
    logger,
    enabledChainIds.filter((chainId) => crossChainAdapterSupportedChains.includes(chainId)),
    adapterManager
  );

  const inventoryClient = new InventoryClient(
    signerAddr,
    logger,
    config.inventoryConfig,
    tokenClient,
    enabledChainIds,
    hubPoolClient,
    bundleDataClient,
    adapterManager,
    crossChainTransferClient,
    !config.sendingRebalancesEnabled
  );

  return { ...commonClients, spokePoolClients, tokenClient, profitClient, inventoryClient, acrossApiClient };
}

export async function updateRelayerClients(clients: RelayerClients, config: RelayerConfig): Promise<void> {
  // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.
  const { acrossApiClient, inventoryClient, profitClient, spokePoolClients, tokenClient } = clients;

  // TODO: the code below can be refined by grouping with promise.all. however you need to consider the inter
  // dependencies of the clients. some clients need to be updated before others. when doing this refactor consider
  // having a "first run" update and then a "normal" update that considers this. see previous implementation here
  // https://github.com/across-protocol/relayer-v2/pull/37/files#r883371256 as a reference.
  const spokePoolEvents = [
    "V3FundsDeposited",
    "RequestedSpeedUpV3Deposit",
    "FilledV3Relay",
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
  ];

  // Start updates w/ no dependencies first, and wait on them last.
  const profitClientUpdate = profitClient.update();
  const inputTokenApprovals = config.sendingRelaysEnabled ? tokenClient.setOriginTokenApprovals() : Promise.resolve();
  const apiClientUpdate = acrossApiClient.update(config.ignoreLimits);

  // InventoryClient updates depend on the tokenClient and SpokePoolClients.
  await Promise.all([clients.tokenClient.update(), updateSpokePoolClients(spokePoolClients, spokePoolEvents)]);

  await Promise.all([
    inventoryClient.update(),
    inventoryClient.wrapL2EthIfAboveThreshold(),
    inventoryClient.setL1TokenApprovals(), // Approve bridge contracts (if rebalancing enabled)
  ]);

  await Promise.all([profitClientUpdate, inputTokenApprovals, apiClientUpdate]);
}
