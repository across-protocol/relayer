import assert from "assert";
import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithStartBlocks,
  updateClients,
  updateSpokePoolClients,
} from "../common";
import { Signer, getArweaveJWKSigner } from "../utils";
import { BundleDataClient, HubPoolClient } from "../clients";
import { getBlockForChain } from "./DataworkerUtils";
import { Dataworker } from "./Dataworker";
import { ProposedRootBundle, SpokePoolClientsByChain } from "../interfaces";
import { caching } from "@across-protocol/sdk";

export interface DataworkerClients extends Clients {
  bundleDataClient: BundleDataClient;
}

export async function constructDataworkerClients(
  logger: winston.Logger,
  config: DataworkerConfig,
  baseSigner: Signer
): Promise<DataworkerClients> {
  // Set hubPoolLookback conservatively to be equal to one month of blocks. If the config.dataworkerFastLookbackCount
  // exceeds ~720 then we'll just use the genesis block since in that case, this dataworker is being used for
  // non-production circumstances (i.e. to execute a very old leaf). 720 is chosen because it's roughly equal to
  // one month worth of bundles assuming 1 bundle an hour.
  const BUNDLES_PER_MONTH = 720;
  const hubPoolLookback = config.dataworkerFastLookbackCount > BUNDLES_PER_MONTH ? undefined : 3600 * 24 * 30;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookback);
  const { hubPoolClient, configStoreClient } = commonClients;

  await updateClients(commonClients, config, logger);
  await hubPoolClient.update();

  // TODO: Remove need to pass in spokePoolClients into BundleDataClient since we pass in empty {} here and pass in
  // clients for each class level call we make. Its more of a static class.
  const bundleDataClient = new BundleDataClient(
    logger,
    commonClients,
    {},
    configStoreClient.getChainIdIndicesForBlock(),
    config.blockRangeEndBlockBuffer
  );

  // Define the Arweave client. We need to use a read-write signer for the
  // dataworker to persist bundle data if `persistingBundleData` is enabled.
  // Otherwise, we can use a read-only signer.
  const arweaveClient = new caching.ArweaveClient(
    getArweaveJWKSigner({ keyType: config.persistingBundleData ? "read-write" : "read-only" }),
    logger,
    config.arweaveGateway?.url,
    config.arweaveGateway?.protocol,
    config.arweaveGateway?.port
  );

  return {
    ...commonClients,
    bundleDataClient,
    arweaveClient,
  };
}

// Constructs spoke pool clients with short lookback and validates that the Dataworker can use the data
// to construct roots. The Dataworker still needs to validate the event set against the bundle block ranges it
// wants to propose or validate.
export async function constructSpokePoolClientsForFastDataworker(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  config: DataworkerConfig,
  baseSigner: Signer,
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
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
    "FundsDeposited",
    "RequestedSlowFill",
    "FilledRelay",
  ]);
  Object.values(spokePoolClients).forEach(({ chainId, isUpdated }) =>
    assert(isUpdated, `Failed to update SpokePoolClient for chain ${chainId}`)
  );
  return spokePoolClients;
}

export function getSpokePoolClientEventSearchConfigsForFastDataworker(
  config: Omit<DataworkerConfig, "validate" | "update">,
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
            // will result in querying from the spoke activation block.
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
