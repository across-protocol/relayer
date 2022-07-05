import { MonitorConfig } from "./MonitorConfig";
import { getSigner, winston } from "../utils";
import { BundleDataClient, HubPoolClient, TokenTransferClient } from "../clients";
import { AdapterManager, CrossChainTransferClient } from "../clients/bridges";
import {
  Clients,
  updateClients,
  updateSpokePoolClients,
  constructClients,
  constructSpokePoolClientsWithLookback,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";

export interface MonitorClients extends Clients {
  bundleDataClient: BundleDataClient;
  crossChainTransferClient: CrossChainTransferClient;
  hubPoolClient: HubPoolClient;
  spokePoolClients: SpokePoolClientsByChain;
  tokenTransferClient: TokenTransferClient;
}

export async function constructMonitorClients(config: MonitorConfig, logger: winston.Logger): Promise<MonitorClients> {
  const baseSigner = await getSigner(); // todo: add getVoidSigner
  const commonClients = await constructClients(logger, config);
  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.configStoreClient,
    config,
    baseSigner,
    config.maxRelayerLookBack
  );
  const bundleDataClient = new BundleDataClient(logger, commonClients, spokePoolClients, config.spokePoolChains);

  // Need to update HubPoolClient to get latest tokens.
  const providerPerChain = Object.fromEntries(
    config.spokePoolChains.map((chainId) => [chainId, spokePoolClients[chainId].spokePool.provider])
  );
  const tokenTransferClient = new TokenTransferClient(logger, providerPerChain, config.monitoredRelayers);

  const adapterManager = new AdapterManager(logger, spokePoolClients, commonClients.hubPoolClient, baseSigner.address);
  const crossChainTransferClient = new CrossChainTransferClient(logger, config.spokePoolChains, adapterManager);

  return { ...commonClients, bundleDataClient, crossChainTransferClient, spokePoolClients, tokenTransferClient };
}

export async function updateMonitorClients(clients: MonitorClients) {
  await updateClients(clients);
  // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.
  await updateSpokePoolClients(clients.spokePoolClients, [
    "FundsDeposited",
    "RequestedSpeedUpDeposit",
    "FilledRelay",
    "EnabledDepositRoute",
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
  ]);
  const allL1Tokens = clients.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address);
  await clients.crossChainTransferClient.update(allL1Tokens);
}
