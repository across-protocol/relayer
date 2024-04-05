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
  CONTRACT_ADDRESSES,
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

  // Set up Spoke signers and connect them to spoke pool contract objects:
  const signer = baseSigner.connect(await getProvider(chainId));

  const blockFinder = undefined;
  const redis = await getRedisCache(hubPoolClient.logger);

  // Grab latest spoke pool as of `toBlockOverride[1]`. If `toBlockOverride[1]` is undefined, then grabs current
  // spoke pool.
  const spokePoolAddr = hubPoolClient.getSpokePoolForBlock(chainId, hubPoolClient.latestBlockSearched);
  const spokePool = new Contract(spokePoolAddr, SpokePool.abi, signer);
  const spokePoolActivationBlock = hubPoolClient.getSpokePoolActivationBlock(chainId, spokePoolAddr);
  const time = (await hubPoolClient.hubPool.provider.getBlock(spokePoolActivationBlock)).timestamp;

  // Improve BlockFinder efficiency by clamping its search space lower bound to the SpokePool deployment block.
  const hints = { lowBlock: getDeploymentBlockNumber("SpokePool", chainId) };
  const registrationBlock = await getBlockForTimestamp(chainId, time, blockFinder, redis, hints);

  return new IndexedSpokePoolClient(
    logger,
    spokePool,
    hubPoolClient,
    chainId,
    registrationBlock,
    { fromBlock: 0, toBlock: 0, maxBlockLookBack: 5_000 },
    worker
  );
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

  const spokePoolClients =
    config.pollingDelay > 0 && config.externalIndexer
      ? Object.fromEntries(
          await sdkUtils.mapAsync(
            enabledChains ?? [1, 10, 137, 324, 8453, 42161, 59144], // @todo: fix
            async (chainId) => [
              chainId,
              await indexedSpokePoolClient(baseSigner, hubPoolClient, chainId, workers[chainId]),
            ]
          )
        )
      : await constructSpokePoolClientsWithLookback(
          logger,
          hubPoolClient,
          configStoreClient,
          config,
          baseSigner,
          config.maxRelayerLookBack,
          enabledChains
        );

  // We only use the API client to load /limits for chains so we should remove any chains that are not included in the
  // destination chain list.
  const destinationSpokePoolClients =
    config.relayerDestinationChains.length === 0
      ? spokePoolClients
      : Object.fromEntries(
          Object.keys(spokePoolClients)
            .filter((chainId) => config.relayerDestinationChains.includes(Number(chainId)))
            .map((chainId) => [chainId, spokePoolClients[chainId]])
        );

  const acrossApiClient = new AcrossApiClient(logger, hubPoolClient, destinationSpokePoolClients, config.relayerTokens);
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

  // The relayer will originate cross chain rebalances from both its own EOA address and the atomic depositor address
  // so we should track both for accurate cross-chain inventory management.
  const atomicDepositor = CONTRACT_ADDRESSES[hubPoolClient.chainId]?.atomicDepositor;
  const monitoredAddresses = [signerAddr, atomicDepositor?.address];
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
  const { spokePoolClients } = clients;

  // TODO: the code below can be refined by grouping with promise.all. however you need to consider the inter
  // dependencies of the clients. some clients need to be updated before others. when doing this refactor consider
  // having a "first run" update and then a "normal" update that considers this. see previous implementation here
  // https://github.com/across-protocol/relayer-v2/pull/37/files#r883371256 as a reference.
  await updateSpokePoolClients(spokePoolClients, [
    "V3FundsDeposited",
    "RequestedSpeedUpV3Deposit",
    "FilledV3Relay",
    "EnabledDepositRoute",
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
  ]);

  // Update the token client first so that inventory client has latest balances.
  await clients.tokenClient.update();

  // We can update the inventory client at the same time as checking for eth wrapping as these do not depend on each other.
  await Promise.all([
    clients.acrossApiClient.update(config.ignoreLimits),
    clients.inventoryClient.update(),
    clients.inventoryClient.wrapL2EthIfAboveThreshold(),
    clients.inventoryClient.setL1TokenApprovals(),
  ]);

  // Update the token client after the inventory client has done its wrapping of L2 ETH to ensure latest WETH ballance.
  // The token client needs route data, so wait for update before checking approvals.
  clients.tokenClient.clearTokenData();
  await clients.tokenClient.update();
  if (config.sendingRelaysEnabled) {
    await clients.tokenClient.setOriginTokenApprovals();
  }
}
