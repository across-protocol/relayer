import { utils as sdkUtils } from "@across-protocol/sdk";
import winston from "winston";
import {
  AcrossApiClient,
  BundleDataClient,
  HubPoolClient,
  InventoryClient,
  ProfitClient,
  TokenClient,
  MultiCallerClient,
  TryMulticallClient,
} from "../clients";
import { IndexedSpokePoolClient, IndexerOpts } from "../clients/SpokePoolClient";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithLookback,
  resolveSpokePoolActivationBlock,
  updateClients,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import { getBlockForTimestamp, getCurrentTime, getProvider, getRedisCache, Signer, SpokePool } from "../utils";
import { RelayerConfig } from "./RelayerConfig";
import { AdapterManager, CrossChainTransferClient } from "../clients/bridges";

export interface RelayerClients extends Clients {
  spokePoolClients: SpokePoolClientsByChain;
  tokenClient: TokenClient;
  profitClient: ProfitClient;
  inventoryClient: InventoryClient;
  acrossApiClient: AcrossApiClient;
  tryMulticallClient: MultiCallerClient;
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
  const { configStoreClient, hubPoolClient, multiCallerClient } = commonClients;
  await updateClients(commonClients, config, logger);
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
        const opts = {
          lookback: config.maxRelayerLookBack,
          blockRange: config.maxBlockLookBack[chainId],
          path: config.listenerPath[chainId],
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
    !config.sendingTransactionsEnabled
  );

  const tryMulticallClient = new TryMulticallClient(logger, multiCallerClient.chunkSize, multiCallerClient.baseSigner);

  return {
    ...commonClients,
    spokePoolClients,
    tokenClient,
    profitClient,
    inventoryClient,
    acrossApiClient,
    tryMulticallClient,
  };
}
