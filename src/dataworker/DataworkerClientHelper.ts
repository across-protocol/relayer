import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import { CHAIN_ID_LIST_INDICES, Clients, constructClients, getSpokePoolSigners, updateClients } from "../common";
import { EventSearchConfig, getDeploymentBlockNumber, Wallet, ethers } from "../utils";
import { BundleDataClient, ProfitClient, SpokePoolClient, TokenClient } from "../clients";

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

  // Dataworker does not yet have to depend on SpokePoolClients so we don't need to construct them for now.
  const spokePoolClients = {};
  const bundleDataClient = new BundleDataClient(logger, commonClients, spokePoolClients, CHAIN_ID_LIST_INDICES);

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

export async function updateDataworkerClients(clients: DataworkerClients, setAllowances=true) {
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
