import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  CHAIN_ID_LIST_INDICES,
  Clients,
  constructClients,
  constructSpokePoolClientsWithStartBlocksAndUpdate,
  getSpokePoolSigners,
  updateClients,
} from "../common";
import { Wallet, ethers, EventSearchConfig, getDeploymentBlockNumber } from "../utils";
import { AcrossConfigStoreClient, BundleDataClient, ProfitClient, SpokePoolClient, TokenClient } from "../clients";

export interface DataworkerClients extends Clients {
  profitClient: ProfitClient;
  tokenClient: TokenClient;
  spokePoolSigners: { [chainId: number]: Wallet };
  spokePoolClientSearchSettings: { [chainId: number]: EventSearchConfig };
  bundleDataClient: BundleDataClient;
}

export async function constructDataworkerClients(
  logger: winston.Logger,
  config: DataworkerConfig,
  baseSigner: Wallet
): Promise<DataworkerClients> {
  const commonClients = await constructClients(logger, config, baseSigner);

  // We don't pass any spoke pool clients to token client since data worker doesn't need to set approvals for L2 tokens.
  const tokenClient = new TokenClient(logger, baseSigner.address, {}, commonClients.hubPoolClient);
  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);
  const spokePoolClientSearchSettings = Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      return [
        chainId,
        {
          fromBlock: Number(getDeploymentBlockNumber("SpokePool", chainId)),
          toBlock: null,
          maxBlockLookBack: config.maxBlockLookBack[chainId],
        },
      ];
    })
  );

  // TODO: Remove need to pass in spokePoolClients into BundleDataClient since we pass in empty {} here and pass in
  // clients for each class level call we make. Its more of a static class.
  const bundleDataClient = new BundleDataClient(logger, commonClients, {}, CHAIN_ID_LIST_INDICES);

  // Disable profitability by default as only the relayer needs it.
  // The dataworker only needs price updates from ProfitClient to calculate bundle volume.
  const profitClient = new ProfitClient(logger, commonClients.hubPoolClient, {}, false, [], true);

  return {
    ...commonClients,
    bundleDataClient,
    profitClient,
    tokenClient,
    spokePoolSigners,
    spokePoolClientSearchSettings,
  };
}

export async function updateDataworkerClients(clients: DataworkerClients, setAllowances = true) {
  await updateClients(clients);

  // Token client needs updated hub pool client to pull bond token data.
  await clients.tokenClient.update();

  // Run approval on hub pool.
  if (setAllowances) await clients.tokenClient.setBondTokenAllowance();

  // Must come after hubPoolClient.
  // TODO: This should be refactored to check if the hubpool client has had one previous update run such that it has
  // L1 tokens within it.If it has we dont need to make it sequential like this.
  await clients.profitClient.update();
}

export function spokePoolClientsToProviders(spokePoolClients: { [chainId: number]: SpokePoolClient }): {
  [chainId: number]: ethers.providers.Provider;
} {
  return Object.fromEntries(
    Object.entries(spokePoolClients).map(([chainId, client]) => [Number(chainId), client.spokePool.signer.provider!])
  );
}

// Constructs spoke pool clients with short lookback and validates that the Dataworker can use the data
// to construct roots. The Dataworker still needs to validate the event set against the bundle block ranges it
// wants to propose or validate.
export async function constructSpokePoolClientsForFastDataworker(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: DataworkerConfig,
  baseSigner: Wallet,
  startBlocks: { [chainId: number]: number }
) {
  return await constructSpokePoolClientsWithStartBlocksAndUpdate(
    logger,
    configStoreClient,
    config,
    baseSigner,
    startBlocks,
    [
      "FundsDeposited",
      "RequestedSpeedUpDeposit",
      "FilledRelay",
      "EnabledDepositRoute",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ]
    // Don't use the cache for the quick lookup so we don't load and parse unneccessary events from Redis DB
    // that we'll throw away if the below checks succeed.
  );
}
