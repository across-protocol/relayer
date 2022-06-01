import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import { Clients, constructClients, getSpokePoolSigners, updateClients, updateSpokePoolClients } from "../common";
import { EventSearchConfig, getDeploymentBlockNumber, getSigner, Wallet, ethers, SpokePool, Contract } from "../utils";
import { SpokePoolClient, TokenClient } from "../clients";

export interface DataworkerClients extends Clients {
  tokenClient: TokenClient;
  spokePoolSigners: { [chainId: number]: Wallet };
  spokePoolClientSearchSettings: { [chainId: number]: EventSearchConfig };
}

// TODO: Deprecate this function in favor of constructSpokePoolClientsWithLookback() in common/
export async function constructSpokePoolClientsForBlockAndUpdate(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  clients: DataworkerClients,
  logger: winston.Logger,
  latestMainnetBlock: number
): Promise<{ [chainId: number]: SpokePoolClient }> {
  const spokePoolClients = Object.fromEntries(
    chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
      const spokePoolContract = new Contract(
        clients.hubPoolClient.getSpokePoolForBlock(latestMainnetBlock, Number(chainId)),
        SpokePool.abi,
        clients.spokePoolSigners[chainId]
      );
      const client = new SpokePoolClient(
        logger,
        spokePoolContract,
        clients.configStoreClient,
        Number(chainId),
        clients.spokePoolClientSearchSettings[chainId],
        clients.spokePoolClientSearchSettings[chainId].fromBlock
      );
      return [chainId, client];
    })
  );
  await updateSpokePoolClients(spokePoolClients);
  return spokePoolClients;
}

export async function constructDataworkerClients(
  logger: winston.Logger,
  config: DataworkerConfig
): Promise<DataworkerClients> {
  const commonClients = await constructClients(logger, config);
  const baseSigner = await getSigner();

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

  return { ...commonClients, tokenClient, spokePoolSigners, spokePoolClientSearchSettings };
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
