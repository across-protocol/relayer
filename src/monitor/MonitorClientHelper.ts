import { MonitorConfig } from "./MonitorConfig";
import { Signer, winston, assert, isEVMSpokePoolClient, toAddressType } from "../utils";
import { BundleDataClient, HubPoolClient, TokenTransferClient } from "../clients";
import {
  Clients,
  updateClients,
  updateSpokePoolClients,
  constructClients,
  constructSpokePoolClientsWithLookback,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import { AdapterManager, CrossChainTransferClient } from "../clients/bridges";

export interface MonitorClients extends Clients {
  bundleDataClient: BundleDataClient;
  crossChainTransferClient: CrossChainTransferClient;
  hubPoolClient: HubPoolClient;
  spokePoolClients: SpokePoolClientsByChain;
  tokenTransferClient: TokenTransferClient;
}

export async function constructMonitorClients(
  config: MonitorConfig,
  logger: winston.Logger,
  baseSigner: Signer
): Promise<MonitorClients> {
  const signerAddr = await baseSigner.getAddress();
  // Set hubPoolLookback conservatively to be equal to one month of blocks. If the config.maxRelayerLookBack
  // exceeds half a month, then we'll just use the gensis block since in that case, this monitor is being used
  // for non-production circumstances.
  const hubPoolLookback = config.maxRelayerLookBack > 3600 * 24 * 15 ? undefined : 3600 * 24 * 30;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookback);
  const { hubPoolClient, configStoreClient } = commonClients;

  await updateClients(commonClients, config, logger);
  await hubPoolClient.update();

  // Construct spoke pool clients for all chains that are not *currently* disabled. Caller can override
  // the disabled chain list by setting the DISABLED_CHAINS_OVERRIDE environment variable.
  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    hubPoolClient,
    configStoreClient,
    config,
    baseSigner,
    config.maxRelayerLookBack
  );
  const bundleDataClient = new BundleDataClient(
    logger,
    commonClients,
    spokePoolClients,
    configStoreClient.getChainIdIndicesForBlock(),
    config.blockRangeEndBlockBuffer
  );

  // Need to update HubPoolClient to get latest tokens.
  const spokePoolAddresses = Object.values(spokePoolClients).map((client) => client.spokePoolAddress);

  // Cross-chain transfers will originate from the HubPool's address and target SpokePool addresses, so
  // track both.
  const adapterManager = new AdapterManager(logger, spokePoolClients, hubPoolClient, [
    toAddressType(signerAddr, hubPoolClient.chainId),
    toAddressType(hubPoolClient.hubPool.address, hubPoolClient.chainId),
    ...spokePoolAddresses,
  ]);
  const spokePoolChains = Object.keys(spokePoolClients).map((chainId) => Number(chainId));
  const providerPerChain = Object.fromEntries(
    spokePoolChains
      .filter((chainId) => isEVMSpokePoolClient(spokePoolClients[chainId]))
      .map((chainId) => {
        const spokePoolClient = spokePoolClients[chainId];
        assert(isEVMSpokePoolClient(spokePoolClient));
        return [chainId, spokePoolClient.spokePool.provider];
      })
  );
  const tokenTransferClient = new TokenTransferClient(logger, providerPerChain, config.monitoredRelayers);

  // The CrossChainTransferClient is dependent on having adapters for all passed in chains
  // so we need to filter out any chains that don't have adapters. This means limiting the chains we keep in
  // `providerPerChain` when constructing the TokenTransferClient and limiting `spokePoolChains` when constructing
  // the CrossChainTransferClient.
  const crossChainAdapterSupportedChains = adapterManager.supportedChains();
  const crossChainTransferClient = new CrossChainTransferClient(
    logger,
    spokePoolChains.filter((chainId) => crossChainAdapterSupportedChains.includes(chainId)),
    adapterManager
  );

  return { ...commonClients, bundleDataClient, crossChainTransferClient, spokePoolClients, tokenTransferClient };
}

export async function updateMonitorClients(clients: MonitorClients): Promise<void> {
  await updateSpokePoolClients(clients.spokePoolClients, [
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
    "FundsDeposited",
    "RequestedSpeedUpDeposit",
    "FilledRelay",
  ]);
  const allL1Tokens = clients.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address);
  await clients.crossChainTransferClient.update(allL1Tokens);
}
