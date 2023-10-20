import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithStartBlocks,
  updateClients,
  updateSpokePoolClients,
} from "../common";
import { Wallet } from "../utils";
import { BundleDataClient, HubPoolClient, ProfitClient, TokenClient } from "../clients";
import { getBlockForChain } from "./DataworkerUtils";
import { Dataworker } from "./Dataworker";
import { ProposedRootBundle, SpokePoolClientsByChain } from "../interfaces";

export interface DataworkerClients extends Clients {
  tokenClient: TokenClient;
  bundleDataClient: BundleDataClient;
  profitClient?: ProfitClient;
}

export async function constructDataworkerClients(
  logger: winston.Logger,
  config: DataworkerConfig,
  baseSigner: Wallet
): Promise<DataworkerClients> {
  const commonClients = await constructClients(logger, config, baseSigner);
  await updateClients(commonClients, config);

  // We don't pass any spoke pool clients to token client since data worker doesn't need to set approvals for L2 tokens.
  const tokenClient = new TokenClient(logger, baseSigner.address, {}, commonClients.hubPoolClient);
  await tokenClient.update();
  // Run approval on hub pool.
  if (config.sendingTransactionsEnabled) {
    await tokenClient.setBondTokenAllowance();
  }

  // TODO: Remove need to pass in spokePoolClients into BundleDataClient since we pass in empty {} here and pass in
  // clients for each class level call we make. Its more of a static class.
  const bundleDataClient = new BundleDataClient(
    logger,
    commonClients,
    {},
    commonClients.configStoreClient.getChainIdIndicesForBlock(),
    config.blockRangeEndBlockBuffer
  );

  // Disable profitability by default as only the relayer needs it.
  // The dataworker only needs price updates from ProfitClient to calculate bundle volume.
  const profitClient = config.proposerEnabled
    ? new ProfitClient(logger, commonClients.hubPoolClient, {}, [], "")
    : undefined;

  // Must come after hubPoolClient.
  // TODO: This should be refactored to check if the hubpool client has had one previous update run such that it has
  // L1 tokens within it.If it has we dont need to make it sequential like this.
  if (profitClient) {
    await profitClient.update();
  }

  return {
    ...commonClients,
    bundleDataClient,
    tokenClient,
    profitClient,
  };
}

// Constructs spoke pool clients with short lookback and validates that the Dataworker can use the data
// to construct roots. The Dataworker still needs to validate the event set against the bundle block ranges it
// wants to propose or validate.
export async function constructSpokePoolClientsForFastDataworker(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  config: DataworkerConfig,
  baseSigner: Wallet,
  startBlocks: { [chainId: number]: number },
  endBlocks: { [chainId: number]: number }
): Promise<SpokePoolClientsByChain> {
  const spokePoolClients = await constructSpokePoolClientsWithStartBlocks(
    logger,
    hubPoolClient,
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
  config: Omit<DataworkerConfig, "loadAndValidateConfigForChains">,
  clients: DataworkerClients,
  dataworker: Dataworker
): {
  fromBundle: ProposedRootBundle;
  toBundle: ProposedRootBundle;
  fromBlocks: { [k: string]: number };
  toBlocks: { [k: string]: number };
} {
  const toBundle =
    config.dataworkerFastStartBundle === "latest"
      ? undefined
      : clients.hubPoolClient.getNthFullyExecutedRootBundle(Number(config.dataworkerFastStartBundle));
  const fromBundle =
    config.dataworkerFastLookbackCount >= Number(config.dataworkerFastStartBundle)
      ? undefined
      : clients.hubPoolClient.getNthFullyExecutedRootBundle(-config.dataworkerFastLookbackCount, toBundle?.blockNumber);

  const toBlocks =
    toBundle === undefined
      ? {}
      : Object.fromEntries(
          dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, i) => {
            // If block for chainId doesn't exist in bundleEvaluationBlockNumbers, then leave undefined which will
            // result in querying until the latest block.
            if (i >= toBundle.bundleEvaluationBlockNumbers.length) {
              return [chainId, undefined];
            }
            return [
              chainId,
              // TODO: I think this has a bug for disabled chains where we don't want to +1 if the chain is disabled
              // at the time of this bundle.
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
          dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, i) => {
            // If block for chainId doesn't exist in bundleEvaluationBlockNumbers, then leave undefined which
            // will reuslt in querying from the spoke activation block.
            if (i >= fromBundle.bundleEvaluationBlockNumbers.length) {
              return [chainId, undefined];
            }
            return [
              chainId,
              // TODO: I think this has a bug for disabled chains where we don't want to +1 if the chain is disabled
              // at the time of this bundle.
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
