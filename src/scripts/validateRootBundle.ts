// How to run:
// 0. Start redis in a separate window: `redis-server`
// 1. You might need to set the following environment variables:
//    REDIS_URL=redis://localhost:6379
//    NODE_URL_1=https://mainnet.infura.io/v3/KEY
//    NODE_URL_10=https://optimism-mainnet.infura.io/v3/KEY
//    NODE_URL_137=https://polygon-mainnet.infura.io/v3/KEY
//    NODE_URL_288=https://mainnet.boba.network/
//    NODE_URL_42161=https://arb-mainnet.g.alchemy.com/v2/KEY
// 2. Example of invalid bundle: REQUEST_TIME=1653594774 ts-node ./src/scripts/validateRootBundle.ts --wallet mnemonic
// 2. Example of valid bundle:   REQUEST_TIME=1653516226 ts-node ./src/scripts/validateRootBundle.ts --wallet mnemonic

import {
  Wallet,
  winston,
  config,
  getSigner,
  startupLogLevel,
  Logger,
  getLatestInvalidBundleStartBlocks,
  getDvmContract,
  getDisputedProposal,
} from "../utils";
import {
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  updateDataworkerClients,
} from "../dataworker/DataworkerClientHelper";
import { BlockFinder } from "@uma/sdk";
import { PendingRootBundle } from "../interfaces";
import { getWidestPossibleExpectedBlockRange } from "../dataworker/PoolRebalanceUtils";
import { createDataworker } from "../dataworker";
import { getEndBlockBuffers } from "../dataworker/DataworkerUtils";

config();
let logger: winston.Logger;

export async function validate(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;
  if (!process.env.REQUEST_TIME) {
    throw new Error("Must set environment variable 'REQUEST_TIME=<NUMBER>' to disputed price request time");
  }
  const priceRequestTime = Number(process.env.REQUEST_TIME);

  const { clients, config, dataworker } = await createDataworker(logger, baseSigner);
  logger[startupLogLevel(config)]({
    at: "RootBundleValidator",
    message: `Validating most recently proposed root bundle before request time ${priceRequestTime}`,
    priceRequestTime,
    config,
  });

  // Construct blockfinder to figure out which block corresponds with the disputed price request time.
  const blockFinder = new BlockFinder(
    clients.configStoreClient.configStore.provider.getBlock.bind(clients.configStoreClient.configStore.provider)
  );
  const priceRequestBlock = (await blockFinder.getBlockForTimestamp(priceRequestTime)).number;

  // Find dispute transaction so we can gain additional confidence that the preceding root bundle is older than the
  // dispute. This is a sanity test against the case where a dispute was submitted atomically following proposal
  // in the same block. This also handles the edge case where multiple disputes and proposals are in the
  // same block.
  const dvm = getDvmContract(clients.configStoreClient.configStore.provider);
  await updateDataworkerClients(clients, false);
  const precedingProposeRootBundleEvent = await getDisputedProposal(
    dvm,
    clients.hubPoolClient,
    priceRequestTime,
    priceRequestBlock
  );
  if (!precedingProposeRootBundleEvent) throw new Error("Failed to identify a root bundle preceding dispute");

  const rootBundle: PendingRootBundle = {
    poolRebalanceRoot: precedingProposeRootBundleEvent.poolRebalanceRoot,
    relayerRefundRoot: precedingProposeRootBundleEvent.relayerRefundRoot,
    slowRelayRoot: precedingProposeRootBundleEvent.slowRelayRoot,
    proposer: precedingProposeRootBundleEvent.proposer,
    unclaimedPoolRebalanceLeafCount: precedingProposeRootBundleEvent.poolRebalanceLeafCount,
    challengePeriodEndTimestamp: precedingProposeRootBundleEvent.challengePeriodEndTimestamp,
    bundleEvaluationBlockNumbers: precedingProposeRootBundleEvent.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
    proposalBlockNumber: precedingProposeRootBundleEvent.blockNumber,
  };

  logger[startupLogLevel(config)]({
    at: "RootBundleValidator",
    message: "Found preceding root bundle",
    transactionHash: precedingProposeRootBundleEvent.transactionHash,
  });

  if (config.dataworkerFastLookbackCount === 0) {
    throw new Error("Set DATAWORKER_FAST_LOOKBACK_COUNT > 0, otherwise script will take too long to run");
  }

  const { fromBundle, toBundle, fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(
    config,
    clients,
    dataworker
  );

  logger.debug({
    at: "RootBundleValidator",
    message:
      "Setting start blocks for SpokePoolClient equal to bundle evaluation end blocks from Nth latest valid root bundle",
    dataworkerFastStartBundle: config.dataworkerFastStartBundle,
    dataworkerFastLookbackCount: config.dataworkerFastLookbackCount,
    fromBlocks,
    toBlocks,
    fromBundleTxn: fromBundle?.transactionHash,
    toBundleTxn: toBundle?.transactionHash,
  });

  const spokePoolClients = await constructSpokePoolClientsForFastDataworker(
    logger,
    clients.configStoreClient,
    config,
    baseSigner,
    fromBlocks,
    toBlocks
  );

  const latestInvalidBundleStartBlocks = getLatestInvalidBundleStartBlocks(spokePoolClients);
  logger.debug({
    at: "RootBundleValidator",
    message:
      "Identified latest invalid bundle start blocks per chain that we will use to filter root bundles that can be proposed and validated",
    latestInvalidBundleStartBlocks,
    fromBlocks,
    toBlocks,
  });

  const widestPossibleBlockRanges = await getWidestPossibleExpectedBlockRange(
    dataworker.chainIdListForBundleEvaluationBlockNumbers,
    spokePoolClients,
    getEndBlockBuffers(dataworker.chainIdListForBundleEvaluationBlockNumbers, dataworker.blockRangeEndBlockBuffer),
    clients,
    priceRequestBlock
  );

  // Validate the event:
  const { valid, reason } = await dataworker.validateRootBundle(
    config.hubPoolChainId,
    widestPossibleBlockRanges,
    rootBundle,
    spokePoolClients,
    latestInvalidBundleStartBlocks
  );

  logger.info({
    at: "RootBundleValidator",
    message: "Validation results",
    rootBundle,
    valid,
    invalidReason: reason,
  });
}

export async function run(_logger: winston.Logger): Promise<void> {
  const baseSigner: Wallet = await getSigner();
  await validate(_logger, baseSigner);
}

// eslint-disable-next-line no-process-exit
run(Logger).then(() => process.exit(0));
