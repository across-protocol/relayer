import { MonitorConfig } from "./MonitorConfig";
import { dedupArray, Signer, winston, toAddressType } from "../utils";
import { BundleDataClient, HubPoolClient } from "../clients";
import {
  Clients,
  updateClients,
  updateSpokePoolClients,
  constructClients,
  constructSpokePoolClientsWithLookback,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import { AdapterManager, CrossChainTransferClient } from "../clients/bridges";
import { constructReadOnlyRebalancerClient } from "../rebalancer/RebalancerClientHelper";
import { RebalancerClient } from "../rebalancer/utils/interfaces";

export interface MonitorClients extends Clients {
  bundleDataClient: BundleDataClient;
  crossChainTransferClient: CrossChainTransferClient;
  hubPoolClient: HubPoolClient;
  rebalancerClient?: RebalancerClient;
  spokePoolClients: SpokePoolClientsByChain;
}

export async function constructMonitorClients(
  config: MonitorConfig,
  logger: winston.Logger,
  baseSigner: Signer
): Promise<MonitorClients> {
  const signerAddr = await baseSigner.getAddress();
  // Set hubPoolLookback conservatively to be equal to one month of blocks. If the config.maxRelayerLookBack
  // exceeds half a month, then we'll just use the genesis block since in that case, this monitor is being used
  // for non-production circumstances.
  const hubPoolLookback = config.maxRelayerLookBack > 3600 * 24 * 15 ? undefined : 3600 * 24 * 30;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookback);
  const { hubPoolClient, configStoreClient } = commonClients;

  await updateClients(commonClients, config, logger);
  // Need to update HubPoolClient to get latest tokens via hubPoolClient.getL1Tokens().
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

  // Spoke pool addresses can be reused on different chains so we need to deduplicate them.
  const spokePoolAddresses = dedupArray(
    Object.values(spokePoolClients).map(({ chainId, spokePoolAddress: address }) => toAddressType(address, chainId))
  );

  // Cross-chain transfers will originate from the HubPool's address and target SpokePool addresses, so
  // track both.
  const adapterManager = new AdapterManager(logger, spokePoolClients, hubPoolClient, [
    toAddressType(signerAddr, hubPoolClient.chainId),
    toAddressType(hubPoolClient.hubPool.address, hubPoolClient.chainId),
    ...config.monitoredRelayers,
    ...spokePoolAddresses,
  ]);
  const spokePoolChains = Object.keys(spokePoolClients).map((chainId) => Number(chainId));

  // The CrossChainTransferClient is dependent on having adapters for all passed in chains
  // so we need to filter out any chains that don't have adapters. This means
  // limiting `spokePoolChains` when constructing
  // the CrossChainTransferClient.
  const crossChainAdapterSupportedChains = adapterManager.supportedChains();
  const crossChainTransferClient = new CrossChainTransferClient(
    logger,
    spokePoolChains.filter((chainId) => crossChainAdapterSupportedChains.includes(chainId)),
    adapterManager
  );
  // Load RebalancerClient in view only mode so that getPendingRebalances() can get called.
  const rebalancerClient = await constructReadOnlyRebalancerClient(logger, baseSigner);

  return {
    ...commonClients,
    bundleDataClient,
    crossChainTransferClient,
    rebalancerClient,
    spokePoolClients,
  };
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
