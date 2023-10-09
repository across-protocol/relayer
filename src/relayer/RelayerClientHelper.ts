import { clients as sdkClients, utils as sdkUtils } from "@across-protocol/sdk-v2";
import winston from "winston";
import { AcrossApiClient, BundleDataClient, InventoryClient, ProfitClient, TokenClient, UBAClient } from "../clients";
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
import { Wallet } from "../utils";
import { RelayerConfig } from "./RelayerConfig";

export interface RelayerClients extends Clients {
  spokePoolClients: SpokePoolClientsByChain;
  ubaClient: UBAClient;
  tokenClient: TokenClient;
  profitClient: ProfitClient;
  inventoryClient: InventoryClient;
  acrossApiClient: AcrossApiClient;
}

export async function constructRelayerClients(
  logger: winston.Logger,
  config: RelayerConfig,
  baseSigner: Wallet
): Promise<RelayerClients> {
  const commonClients = await constructClients(logger, config, baseSigner);
  await updateClients(commonClients, config);

  // Construct spoke pool clients for all chains that are not *currently* disabled. Caller can override
  // the disabled chain list by setting the DISABLED_CHAINS_OVERRIDE environment variable.
  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.hubPoolClient,
    commonClients.configStoreClient,
    config,
    baseSigner,
    config.maxRelayerLookBack
  );

  const ubaClient = new UBAClient(
    new sdkClients.UBAClientConfig(),
    commonClients.hubPoolClient.getL1Tokens().map((token) => token.symbol),
    commonClients.hubPoolClient,
    spokePoolClients
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

  const acrossApiClient = new AcrossApiClient(
    logger,
    commonClients.hubPoolClient,
    destinationSpokePoolClients,
    config.relayerTokens
  );
  const tokenClient = new TokenClient(logger, baseSigner.address, spokePoolClients, commonClients.hubPoolClient);

  // If `relayerDestinationChains` is a non-empty array, then copy its value, otherwise default to all chains.
  const enabledChainIds = (
    config.relayerDestinationChains.length > 0
      ? config.relayerDestinationChains
      : commonClients.configStoreClient.getChainIdIndicesForBlock()
  ).filter((chainId) => Object.keys(spokePoolClients).includes(chainId.toString()));
  const profitClient = new ProfitClient(
    logger,
    commonClients.hubPoolClient,
    spokePoolClients,
    enabledChainIds,
    config.minRelayerFeePct,
    config.debugProfitability,
    config.relayerGasMultiplier
  );
  await profitClient.update();

  // The relayer will originate cross chain rebalances from both its own EOA address and the atomic depositor address
  // so we should track both for accurate cross-chain inventory management.
  const atomicDepositor = CONTRACT_ADDRESSES[commonClients.hubPoolClient.chainId]?.atomicDepositor;
  const monitoredAddresses = [baseSigner.address, atomicDepositor?.address];
  const adapterManager = new AdapterManager(
    logger,
    spokePoolClients,
    commonClients.hubPoolClient,
    monitoredAddresses.filter(() => sdkUtils.isDefined)
  );

  const bundleDataClient = new BundleDataClient(
    logger,
    commonClients,
    spokePoolClients,
    commonClients.configStoreClient.getChainIdIndicesForBlock(),
    config.blockRangeEndBlockBuffer
  );
  const crossChainTransferClient = new CrossChainTransferClient(logger, enabledChainIds, adapterManager);
  const inventoryClient = new InventoryClient(
    baseSigner.address,
    logger,
    config.inventoryConfig,
    tokenClient,
    enabledChainIds,
    commonClients.hubPoolClient,
    bundleDataClient,
    adapterManager,
    crossChainTransferClient,
    config.bundleRefundLookback,
    !config.sendingRelaysEnabled
  );

  return { ...commonClients, spokePoolClients, ubaClient, tokenClient, profitClient, inventoryClient, acrossApiClient };
}

export async function updateRelayerClients(clients: RelayerClients, config: RelayerConfig): Promise<void> {
  // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.
  const { configStoreClient, spokePoolClients, ubaClient } = clients;

  await configStoreClient.update();
  const version = configStoreClient.getConfigStoreVersionForTimestamp();
  if (sdkUtils.isUBA(version)) {
    await ubaClient.update();
  } else {
    // TODO: the code below can be refined by grouping with promise.all. however you need to consider the inter
    // dependencies of the clients. some clients need to be updated before others. when doing this refactor consider
    // having a "first run" update and then a "normal" update that considers this. see previous implementation here
    // https://github.com/across-protocol/relayer-v2/pull/37/files#r883371256 as a reference.
    await updateSpokePoolClients(spokePoolClients, [
      "FundsDeposited",
      "RequestedSpeedUpDeposit",
      "FilledRelay",
      "EnabledDepositRoute",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ]);
  }

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
  await clients.tokenClient.update();
  if (config.sendingRelaysEnabled) {
    await clients.tokenClient.setOriginTokenApprovals();
  }
}
