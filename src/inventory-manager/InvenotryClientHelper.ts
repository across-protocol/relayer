import { arch, utils as sdkUtils } from "@across-protocol/sdk";
import winston from "winston";
import { EVMSpokePoolClient, SVMSpokePoolClient, HubPoolClient, InventoryClient, TokenClient } from "../clients";
import { SpokeListener, SpokePoolClient, IndexerOpts } from "../clients/SpokePoolClient";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithLookback,
  resolveSpokePoolActivationBlock,
  updateClients,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import {
  chainIsEvm,
  getBlockForTimestamp,
  getCurrentTime,
  getProvider,
  getRedisCache,
  getSvmProvider,
  Signer,
  SpokePool,
  SvmAddress,
  EvmAddress,
  getSvmSignerFromEvmSigner,
} from "../utils";
import { InventoryManagerConfig } from "./InventoryManagerConfig";
import { AdapterManager, CrossChainTransferClient } from "../clients/bridges";

export interface InventoryManagerClients extends Clients {
  spokePoolClients: SpokePoolClientsByChain;
  tokenClient: TokenClient;
  inventoryClient: InventoryClient;
}

async function indexedSpokePoolClient(
  baseSigner: Signer,
  hubPoolClient: HubPoolClient,
  chainId: number,
  opts: IndexerOpts & { lookback: number; blockRange: number }
): Promise<SpokePoolClient> {
  const { logger } = hubPoolClient;

  // Set up Spoke signers and connect them to spoke pool contract objects.
  const signer = baseSigner.connect(await getProvider(chainId));
  const spokePoolAddr = hubPoolClient.getSpokePoolForBlock(chainId);

  const blockFinder = undefined;
  const redis = await getRedisCache(hubPoolClient.logger);
  const [activationBlock, from] = await Promise.all([
    resolveSpokePoolActivationBlock(chainId, hubPoolClient),
    getBlockForTimestamp(logger, chainId, getCurrentTime() - opts.lookback, blockFinder, redis),
  ]);
  const searchConfig = { from, maxLookBack: opts.blockRange };

  if (chainIsEvm(chainId)) {
    const contract = SpokePool.connect(spokePoolAddr.toEvmAddress(), signer);
    const SpokePoolClient = SpokeListener(EVMSpokePoolClient);
    const spokePoolClient = new SpokePoolClient(
      logger,
      contract,
      hubPoolClient,
      chainId,
      activationBlock,
      searchConfig
    );
    spokePoolClient.init(opts);
    return spokePoolClient;
  } else {
    const provider = getSvmProvider(await getRedisCache());
    const svmEventsClient = await arch.svm.SvmCpiEventsClient.create(provider);
    const programId = svmEventsClient.getProgramAddress();
    const statePda = await arch.svm.getStatePda(programId);
    const SpokePoolClient = SpokeListener(SVMSpokePoolClient);
    const spokePoolClient = new SpokePoolClient(
      logger,
      hubPoolClient,
      chainId,
      BigInt(activationBlock),
      searchConfig,
      svmEventsClient,
      programId,
      statePda
    );
    spokePoolClient.init(opts);
    return spokePoolClient;
  }
}

export async function constructInventoryManagerClients(
  logger: winston.Logger,
  config: InventoryManagerConfig,
  baseSigner: Signer
): Promise<InventoryManagerClients> {
  const _signerAddr = await baseSigner.getAddress();
  const signerAddr = EvmAddress.from(_signerAddr);
  // The relayer only uses the HubPoolClient to query repayments refunds for the latest validated
  // bundle and the pending bundle. 8 hours should cover the latest two bundles on production in
  // almost all cases. Look back to genesis on testnets.
  const hubPoolLookBack = sdkUtils.chainIsProd(config.hubPoolChainId) ? 3600 * 8 : Number.POSITIVE_INFINITY;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookBack);
  const { configStoreClient, hubPoolClient } = commonClients;
  await updateClients(commonClients, config, logger);
  await hubPoolClient.update();

  // If both origin and destination chains are configured, then limit the SpokePoolClients instantiated to the
  // sum of them. Otherwise, do not specify the chains to be instantiated to inherit one SpokePoolClient per
  // enabled chain.
  const enabledChains = config.spokePoolChainsOverride;

  let spokePoolClients: SpokePoolClientsByChain;
  if (config.externalListener) {
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

  const relayerTokens = sdkUtils.dedupArray([
    ...config.relayerTokens,
    ...Object.keys(config?.inventoryConfig?.tokenConfig ?? {}).map((token) => EvmAddress.from(token)),
  ]);

  const svmSigner = getSvmSignerFromEvmSigner(baseSigner);
  const svmAddress = SvmAddress.from(svmSigner.publicKey.toBase58());
  const tokenClient = new TokenClient(logger, signerAddr, svmAddress, spokePoolClients, hubPoolClient, relayerTokens);

  // If `relayerDestinationChains` is a non-empty array, then copy its value, otherwise default to all chains.
  const enabledChainIds = (
    config.relayerDestinationChains.length > 0
      ? config.relayerDestinationChains
      : configStoreClient.getChainIdIndicesForBlock()
  ).filter((chainId) => Object.keys(spokePoolClients).includes(chainId.toString()));

  const monitoredAddresses = [signerAddr];
  const adapterManager = new AdapterManager(logger, spokePoolClients, hubPoolClient, monitoredAddresses);

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
    adapterManager,
    crossChainTransferClient
  );

  return {
    ...commonClients,
    spokePoolClients,
    tokenClient,
    inventoryClient,
  };
}
