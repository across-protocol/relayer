import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import { CHAIN_ID_LIST_INDICES, Clients, constructClients, getSpokePoolSigners, updateClients } from "../common";
import { EventSearchConfig, getDeploymentBlockNumber, Wallet, ethers } from "../utils";
import { BundleDataClient, SpokePoolClient, TokenClient } from "../clients";

export interface DataworkerClients extends Clients {
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
  return { ...commonClients, bundleDataClient, tokenClient, spokePoolSigners, spokePoolClientSearchSettings };
}

export async function updateDataworkerClients(clients: DataworkerClients) {
  await updateClients(clients);

  // Token client needs updated hub pool client to pull bond token data.
  await clients.tokenClient.update();

  // Run approval on hub pool.
  await clients.tokenClient.setBondTokenAllowance();
}

export function spokePoolClientsToProviders(spokePoolClients: { [chainId: number]: SpokePoolClient }): {
  [chainId: number]: ethers.providers.Provider;
} {
  return Object.fromEntries(
    Object.entries(spokePoolClients).map(([chainId, client]) => [Number(chainId), client.spokePool.signer.provider!])
  );
}
