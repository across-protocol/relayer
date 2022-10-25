import winston from "winston";
import { Wallet } from "../utils";
import { TokenClient, ProfitClient, BundleDataClient, InventoryClient } from "../clients";
import { AdapterManager, CrossChainTransferClient } from "../clients/bridges";
import { RelayerConfig } from "./RelayerConfig";
import { CHAIN_ID_LIST_INDICES, Clients, constructClients, updateClients, updateSpokePoolClients } from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import { constructSpokePoolClientsWithLookback } from "../common";

export interface RelayerClients extends Clients {
  spokePoolClients: SpokePoolClientsByChain;
  tokenClient: TokenClient;
  profitClient: ProfitClient;
  inventoryClient: InventoryClient;
}

export async function constructRelayerClients(
  logger: winston.Logger,
  config: RelayerConfig,
  baseSigner: Wallet
): Promise<RelayerClients> {
  const commonClients = await constructClients(logger, config, baseSigner);

  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.configStoreClient,
    config,
    baseSigner,
    config.maxRelayerLookBack
  );

  const tokenClient = new TokenClient(logger, baseSigner.address, spokePoolClients, commonClients.hubPoolClient);

  // If `relayerDestinationChains` is a non-empty array, then copy its value, otherwise default to all chains.
  const enabledChainIds =
    config.relayerDestinationChains.length > 0 ? config.relayerDestinationChains : CHAIN_ID_LIST_INDICES;
  const profitClient = new ProfitClient(
    logger,
    commonClients.hubPoolClient,
    spokePoolClients,
    config.ignoreProfitability,
    enabledChainIds,
    config.ignoreTokenPriceFailures,
    config.minRelayerFeePct,
    config.debugProfitability,
    config.relayerGasMultiplier
  );

  const adapterManager = new AdapterManager(logger, spokePoolClients, commonClients.hubPoolClient, [
    baseSigner.address,
  ]);

  const bundleDataClient = new BundleDataClient(logger, commonClients, spokePoolClients, config.spokePoolChains);
  const crossChainTransferClient = new CrossChainTransferClient(logger, config.spokePoolChains, adapterManager);
  const inventoryClient = new InventoryClient(
    baseSigner.address,
    logger,
    config.inventoryConfig,
    tokenClient,
    config.spokePoolChains,
    commonClients.hubPoolClient,
    bundleDataClient,
    adapterManager,
    crossChainTransferClient,
    config.bundleRefundLookback
  );

  return { ...commonClients, spokePoolClients, tokenClient, profitClient, inventoryClient };
}

export async function updateRelayerClients(clients: RelayerClients, config: RelayerConfig) {
  await updateClients(clients);
  await clients.profitClient.update();
  // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.

  // TODO: the code below can be refined by grouping with promise.all. however you need to consider the inter
  // dependencies of the clients. some clients need to be updated before others. when doing this refactor consider
  // having a "first run" update and then a "normal" update that considers this. see previous implementation here
  // https://github.com/across-protocol/relayer-v2/pull/37/files#r883371256 as a reference.
  await updateSpokePoolClients(clients.spokePoolClients, [
    "FundsDeposited",
    "RequestedSpeedUpDeposit",
    "FilledRelay",
    "EnabledDepositRoute",
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
  ]);

  // Update the token client first so that inventory client has latest balances.

  await clients.tokenClient.update();

  // We can update the inventory client at the same time as checking for eth wrapping as these do not depend on each other.
  await Promise.all([
    clients.inventoryClient.update(),
    clients.inventoryClient.wrapL2EthIfAboveThreshold(),
    clients.inventoryClient.setL1TokenApprovals(),
  ]);

  // Update the token client after the inventory client has done its wrapping of L2 ETH to ensure latest WETH ballance.
  // The token client needs route data, so wait for update before checking approvals.
  await clients.tokenClient.update();
  if (config.sendingRelaysEnabled)
    await clients.tokenClient.setOriginTokenApprovals();
}
