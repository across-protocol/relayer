import { utils as sdkUtils } from "@across-protocol/sdk";
import winston from "winston";
import {
  AcrossApiClient,
  BundleDataClient,
  HubPoolClient,
  InventoryClient,
  ProfitClient,
  TokenClient,
} from "../clients";
import { IndexedSpokePoolClient, IndexerOpts } from "../clients/SpokePoolClient";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithLookback,
  resolveSpokePoolActivationBlock,
  updateClients,
  updateSpokePoolClients,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import { getBlockForTimestamp, getCurrentTime, getProvider, getRedisCache, Signer, SpokePool } from "../utils";
import { RelayerConfig } from "./RelayerConfig";

import { GenericAdapterManager } from "../adapter/AdapterManager";
import { AdapterManager, CrossChainTransferClient } from "../clients/bridges";

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
  opts: IndexerOpts & { lookback: number; blockRange: number }
): Promise<IndexedSpokePoolClient> {
  const { logger } = hubPoolClient;

  // Set up Spoke signers and connect them to spoke pool contract objects.
  const signer = baseSigner.connect(await getProvider(chainId));
  const spokePoolAddr = hubPoolClient.getSpokePoolForBlock(chainId);

  const blockFinder = undefined;
  const redis = await getRedisCache(hubPoolClient.logger);
  const [activationBlock, fromBlock] = await Promise.all([
    resolveSpokePoolActivationBlock(chainId, hubPoolClient),
    getBlockForTimestamp(chainId, getCurrentTime() - opts.lookback, blockFinder, redis),
  ]);

  const spokePoolClient = new IndexedSpokePoolClient(
    logger,
    SpokePool.connect(spokePoolAddr, signer),
    hubPoolClient,
    chainId,
    activationBlock,
    { fromBlock, maxBlockLookBack: opts.blockRange },
    opts
  );

  return spokePoolClient;
}

export async function constructRelayerClients(
  logger: winston.Logger,
  config: RelayerConfig,
  baseSigner: Signer
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
      await sdkUtils.mapAsync(enabledChains ?? configStoreClient.getEnabledChains(), async (chainId) => {
        const finality = config.minDepositConfirmations[chainId].at(0)?.minConfirmations ?? 1024;
        const opts = {
          finality,
          lookback: config.maxRelayerLookBack,
          blockRange: config.maxBlockLookBack[chainId],
        };
        return [chainId, await indexedSpokePoolClient(baseSigner, hubPoolClient, chainId, opts)];
      })
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
  await profitClient.update();

  const monitoredAddresses = [signerAddr];
  const adapterManagerConstructor = config.useGenericAdapter ? GenericAdapterManager : AdapterManager;
  const adapterManager = new adapterManagerConstructor(
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
  const { spokePoolClients } = clients;

  // TODO: the code below can be refined by grouping with promise.all. however you need to consider the inter
  // dependencies of the clients. some clients need to be updated before others. when doing this refactor consider
  // having a "first run" update and then a "normal" update that considers this. see previous implementation here
  // https://github.com/across-protocol/relayer/pull/37/files#r883371256 as a reference.
  await updateSpokePoolClients(spokePoolClients, [
    "V3FundsDeposited",
    "RequestedSpeedUpV3Deposit",
    "FilledV3Relay",
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
  ]);

  // Update the token client first so that inventory client has latest balances.
  await clients.tokenClient.update();

  // We can update the inventory client in parallel with checking for eth wrapping as these do not depend on each other.
  // Cross-chain deposit tracking produces duplicates in looping mode, so in that case don't attempt it. This does not
  // disable inventory management, but does make it ignorant of in-flight cross-chain transfers. The rebalancer is
  // assumed to run separately from the relayer and with pollingDelay 0, so it doesn't loop and will track transfers
  // correctly to avoid repeat rebalances.
  const inventoryChainIds =
    config.pollingDelay === 0 ? Object.values(spokePoolClients).map(({ chainId }) => chainId) : [];
  await Promise.all([
    clients.acrossApiClient.update(config.ignoreLimits),
    clients.inventoryClient.update(inventoryChainIds),
    clients.inventoryClient.wrapL2EthIfAboveThreshold(),
    clients.inventoryClient.setL1TokenApprovals(),
    config.sendingRelaysEnabled ? clients.tokenClient.setOriginTokenApprovals() : Promise.resolve(),
  ]);
}
