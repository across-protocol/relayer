// How to run:
// 0. Start redis in a separate window: `redis-server`
// 1. You might need to set the following environment variables:
//    REDIS_URL=redis://localhost:6379
//    NODE_URL_1=https://mainnet.infura.io/v3/KEY
//    NODE_URL_10=https://optimism-mainnet.infura.io/v3/KEY
//    NODE_URL_137=https://polygon-mainnet.infura.io/v3/KEY
//    NODE_URL_288=https://replica.boba.network/
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
  getDvmContract,
  getDisputedProposal,
  getBlockForTimestamp,
  getCurrentTime,
  sortEventsDescending,
  getDisputeForTimestamp,
  disconnectRedisClient,
} from "../utils";
import {
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  updateDataworkerClients,
} from "../dataworker/DataworkerClientHelper";
import { PendingRootBundle, ProposedRootBundle } from "../interfaces";
import { getWidestPossibleExpectedBlockRange } from "../dataworker/PoolRebalanceUtils";
import { createDataworker } from "../dataworker";
import { getBlockForChain, getEndBlockBuffers } from "../dataworker/DataworkerUtils";
import { CONFIG_STORE_VERSION } from "../common";

config();
let logger: winston.Logger;

export async function validate(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;
  if (!process.env.REQUEST_TIME) {
    throw new Error("Must set environment variable 'REQUEST_TIME=<NUMBER>' to disputed price request time");
  }
  const priceRequestTime = Number(process.env.REQUEST_TIME);

  // Override default config with sensible defaults:
  // - DATAWORKER_FAST_LOOKBACK_COUNT=8 balances limiting RPC requests with querying
  // enough data to limit # of excess historical deposit queries.
  // - SPOKE_ROOTS_LOOKBACK_COUNT unused in this script so set to something < DATAWORKER_FAST_LOOKBACK_COUNT
  // to avoid configuration error.
  process.env.DATAWORKER_FAST_LOOKBACK_COUNT = "8";
  process.env.SPOKE_ROOTS_LOOKBACK_COUNT = "1";
  const { clients, config, dataworker } = await createDataworker(logger, baseSigner);
  logger[startupLogLevel(config)]({
    at: "RootBundleValidator",
    message: `Validating most recently proposed root bundle before request time ${priceRequestTime}`,
    priceRequestTime,
    config,
  });

  // Figure out which block corresponds with the disputed price request time.
  const priceRequestBlock = await getBlockForTimestamp(
    clients.hubPoolClient.chainId,
    clients.hubPoolClient.chainId,
    priceRequestTime,
    getCurrentTime()
  );

  // Find dispute transaction so we can gain additional confidence that the preceding root bundle is older than the
  // dispute. This is a sanity test against the case where a dispute was submitted atomically following proposal
  // in the same block. This also handles the edge case where multiple disputes and proposals are in the
  // same block.
  const dvm = await getDvmContract(clients.configStoreClient.configStore.provider);
  await updateDataworkerClients(clients, false);

  if (!clients.configStoreClient.hasLatestConfigStoreVersion) {
    logger.error({
      at: "Dataworker#validate",
      message: "Cannot validate because missing updated ConfigStore version. Update to latest code.",
      latestVersionSupported: CONFIG_STORE_VERSION,
      latestInConfigStore: clients.configStoreClient.getConfigStoreVersionForTimestamp(),
    });
    return;
  }

  // If request timestamp corresponds to a dispute, use that to easily find the associated root bundle.
  const disputeEventForRequestTime = await getDisputeForTimestamp(
    dvm,
    clients.configStoreClient,
    priceRequestTime,
    priceRequestBlock
  );
  let precedingProposeRootBundleEvent: ProposedRootBundle;
  if (disputeEventForRequestTime !== undefined) {
    precedingProposeRootBundleEvent = getDisputedProposal(clients.configStoreClient, disputeEventForRequestTime);
  }
  if (disputeEventForRequestTime === undefined || precedingProposeRootBundleEvent === undefined) {
    logger.debug({
      at: "Dataworker#validate",
      message:
        "No bundle linked to dispute found for request time, falling back to most recent root bundle before request time",
      foundDisputeEvent: disputeEventForRequestTime !== undefined,
      foundProposedRootBundle: precedingProposeRootBundleEvent !== undefined,
    });
    // Timestamp doesn't correspond to a dispute, so find the most recent root bundle before the request time.
    precedingProposeRootBundleEvent = sortEventsDescending(clients.hubPoolClient.getProposedRootBundles()).find(
      (x) => x.blockNumber <= priceRequestBlock
    );
  }
  if (!precedingProposeRootBundleEvent) {
    throw new Error("No proposed root bundle found before request time");
  }

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

  // Calculate the latest blocks we should query in the spoke pool client so we can efficiently reconstruct
  // older bundles. We do this by setting toBlocks equal to the bundle end blocks of the first validated bundle
  // following the target bundle.
  const closestFollowingValidatedBundleIndex = clients.hubPoolClient
    .getValidatedRootBundles()
    .findIndex((x) => x.blockNumber > rootBundle.proposalBlockNumber);
  // We want the bundle end of blocks following the target bundle so add +1 to the index.
  const overriddenConfig = {
    ...config,
    dataworkerFastStartBundle:
      closestFollowingValidatedBundleIndex === -1 ? "latest" : closestFollowingValidatedBundleIndex + 1,
  };

  const { fromBundle, toBundle, fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(
    overriddenConfig,
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

  const mainnetBundleEndBlock = getBlockForChain(
    rootBundle.bundleEvaluationBlockNumbers,
    1,
    dataworker.chainIdListForBundleEvaluationBlockNumbers
  );
  const widestPossibleBlockRanges = getWidestPossibleExpectedBlockRange(
    dataworker.chainIdListForBundleEvaluationBlockNumbers,
    spokePoolClients,
    getEndBlockBuffers(dataworker.chainIdListForBundleEvaluationBlockNumbers, dataworker.blockRangeEndBlockBuffer),
    clients,
    priceRequestBlock,
    clients.configStoreClient.getEnabledChains(
      mainnetBundleEndBlock,
      dataworker.chainIdListForBundleEvaluationBlockNumbers
    )
  );

  // Validate the event:
  const { valid, reason } = await dataworker.validateRootBundle(
    config.hubPoolChainId,
    widestPossibleBlockRanges,
    rootBundle,
    spokePoolClients,
    fromBlocks
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
  await disconnectRedisClient(logger);
}

// eslint-disable-next-line no-process-exit
run(Logger).then(async () => process.exit(0));
