import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  CHAIN_ID_LIST_INDICES,
  Clients,
  CommonConfig,
  constructClients,
  getSpokePoolClientsForContract,
  getSpokePoolSigners,
  updateClients,
  updateSpokePoolClients,
} from "../common";
import { Wallet, ethers, EventSearchConfig, getDeploymentBlockNumber, getDeployedContract, Contract } from "../utils";
import { AcrossConfigStoreClient, BundleDataClient, ProfitClient, SpokePoolClient, TokenClient } from "../clients";
import { getBlockForChain } from "./DataworkerUtils";
import { Dataworker } from "./Dataworker";
import { SpokePoolClientsByChain } from "../interfaces";

export interface DataworkerClients extends Clients {
  tokenClient: TokenClient;
  spokePoolSigners: { [chainId: number]: Wallet };
  spokePoolClientSearchSettings: { [chainId: number]: EventSearchConfig };
  bundleDataClient: BundleDataClient;
  profitClient?: ProfitClient;
}

export async function constructDataworkerClients(
  logger: winston.Logger,
  config: DataworkerConfig,
  baseSigner: Wallet
): Promise<DataworkerClients> {
  const commonClients = await constructClients(logger, config, baseSigner);

  // We don't pass any spoke pool clients to token client since data worker doesn't need to set approvals for L2 tokens.
  const tokenClient = new TokenClient(logger, baseSigner.address, {}, commonClients.hubPoolClient);
  const spokePoolSigners = await getSpokePoolSigners(baseSigner, config);
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
  const profitClient = config.proposerEnabled
    ? new ProfitClient(logger, commonClients.hubPoolClient, {}, false, [])
    : undefined;

  return {
    ...commonClients,
    bundleDataClient,
    tokenClient,
    spokePoolSigners,
    spokePoolClientSearchSettings,
    profitClient,
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
  if (clients.profitClient) await clients.profitClient.update();
}

export function spokePoolClientsToProviders(spokePoolClients: { [chainId: number]: SpokePoolClient }): {
  [chainId: number]: ethers.providers.Provider;
} {
  return Object.fromEntries(
    Object.entries(spokePoolClients).map(([chainId, client]) => [Number(chainId), client.spokePool.signer.provider!])
  );
}

export async function constructSpokePoolClientsWithStartBlocks(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: CommonConfig,
  baseSigner: Wallet,
  startBlockOverride: { [chainId: number]: number } = {},
  toBlockOverride: { [chainId: number]: number } = {}
): Promise<SpokePoolClientsByChain> {
  // Set up Spoke signers and connect them to spoke pool contract objects:
  const spokePoolSigners = await getSpokePoolSigners(baseSigner, config);
  const spokePools = config.spokePoolChains.map((chainId) => {
    return { chainId, contract: getDeployedContract("SpokePool", chainId, spokePoolSigners[chainId]) };
  });

  // If no lookback is set, fromBlock will be set to spoke pool's deployment block.
  const fromBlocks: { [chainId: number]: number } = {};
  spokePools.forEach((obj: { chainId: number; contract: Contract }) => {
    if (startBlockOverride[obj.chainId]) {
      fromBlocks[obj.chainId] = startBlockOverride[obj.chainId];
    }
  });

  return getSpokePoolClientsForContract(logger, configStoreClient, config, spokePools, fromBlocks, toBlockOverride);
}

// Constructs spoke pool clients with short lookback and validates that the Dataworker can use the data
// to construct roots. The Dataworker still needs to validate the event set against the bundle block ranges it
// wants to propose or validate.
export async function constructSpokePoolClientsForFastDataworker(
  logger: winston.Logger,
  configStoreClient: AcrossConfigStoreClient,
  config: DataworkerConfig,
  baseSigner: Wallet,
  startBlocks: { [chainId: number]: number },
  endBlocks: { [chainId: number]: number }
) {
  const spokePoolClients = await constructSpokePoolClientsWithStartBlocks(
    logger,
    configStoreClient,
    config,
    baseSigner,
    startBlocks,
    endBlocks
  );
  await updateSpokePoolClients(spokePoolClients, [
    "FundsDeposited",
    "RequestedSpeedUpDeposit",
    "FilledRelay",
    "EnabledDepositRoute",
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
  ]);
  return spokePoolClients;
}

export function getSpokePoolClientEventSearchConfigsForFastDataworker(
  config: DataworkerConfig,
  clients: DataworkerClients,
  dataworker: Dataworker
) {
  const toBundle =
    config.dataworkerFastStartBundle === "latest"
      ? undefined
      : clients.hubPoolClient.getNthFullyExecutedRootBundle(Number(config.dataworkerFastStartBundle));
  const fromBundle =
    config.dataworkerFastLookbackCount >= config.dataworkerFastStartBundle
      ? undefined
      : clients.hubPoolClient.getNthFullyExecutedRootBundle(-config.dataworkerFastLookbackCount, toBundle?.blockNumber);

  const toBlocks =
    toBundle === undefined
      ? {}
      : Object.fromEntries(
          dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
            return [
              chainId,
              getBlockForChain(
                toBundle.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
                chainId,
                dataworker.chainIdListForBundleEvaluationBlockNumbers
              ) + 1, // Need to add 1 to bundle end block since bundles begin at previous bundle end blocks + 1
            ];
          })
        );
  const fromBlocks =
    fromBundle === undefined
      ? {}
      : Object.fromEntries(
          dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
            return [
              chainId,
              getBlockForChain(
                fromBundle.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
                chainId,
                dataworker.chainIdListForBundleEvaluationBlockNumbers
              ) + 1, // Need to add 1 to bundle end block since bundles begin at previous bundle end blocks + 1
            ];
          })
        );

  return {
    fromBundle,
    toBundle,
    fromBlocks,
    toBlocks,
  };
}
