// How to run:
// 0. Start redis in a separate window: `redis-server`
// 1. You might need to set the following environment variables:
//    REDIS_URL=redis://localhost:6379
//    NODE_URL_1=https://mainnet.infura.io/v3/KEY
//    NODE_URL_10=https://optimism-mainnet.infura.io/v3/KEY
//    NODE_URL_137=https://polygon-mainnet.infura.io/v3/KEY
//    NODE_URL_42161=https://arb-mainnet.g.alchemy.com/v2/KEY
// 2. To validate the proposal at timestamp 1653594774:
//    REQUEST_TIME=1653594774 ts-node ./src/scripts/validateRootBundle.ts

import {
  winston,
  config,
  getSigner,
  startupLogLevel,
  Logger,
  getDvmContract,
  getDisputedProposal,
  getBlockForTimestamp,
  sortEventsDescending,
  getDisputeForTimestamp,
  disconnectRedisClients,
  Signer,
  getEndBlockBuffers,
  getWidestPossibleExpectedBlockRange,
} from "../utils";
import {
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
} from "../dataworker/DataworkerClientHelper";
import { PendingRootBundle, ProposedRootBundle } from "../interfaces";
import { createDataworker } from "../dataworker";
import { getBlockForChain } from "../dataworker/DataworkerUtils";

config();
let logger: winston.Logger;

export async function validate(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
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
  process.env.DATAWORKER_FAST_LOOKBACK_COUNT = "10";
  process.env.SPOKE_ROOTS_LOOKBACK_COUNT = "1";
  const { clients, config, dataworker } = await createDataworker(logger, baseSigner);
  logger[startupLogLevel(config)]({
    at: "RootBundleValidator",
    message: `Validating most recently proposed root bundle before request time ${priceRequestTime}`,
    priceRequestTime,
    config,
  });

  // Figure out which block corresponds with the disputed price request time.
  const priceRequestBlock = await getBlockForTimestamp(clients.hubPoolClient.chainId, priceRequestTime);
  logger.debug({
    at: "Dataworker#validate",
    message: `Price request block found for request time ${priceRequestTime}`,
    priceRequestBlock,
  });

  // Find dispute transaction so we can gain additional confidence that the preceding root bundle is older than the
  // dispute. This is a sanity test against the case where a dispute was submitted atomically following proposal
  // in the same block. This also handles the edge case where multiple disputes and proposals are in the
  // same block.
  const dvm = await getDvmContract(clients.configStoreClient.configStore.provider);

  if (!clients.configStoreClient.hasLatestConfigStoreVersion) {
    logger.error({
      at: "Dataworker#validate",
      message: "Cannot validate because missing updated ConfigStore version. Update to latest code.",
      latestVersionSupported: clients.configStoreClient.configStoreVersion,
      latestInConfigStore: clients.configStoreClient.getConfigStoreVersionForTimestamp(),
    });
    return;
  }

  // If request timestamp corresponds to a dispute, use that to easily find the associated root bundle.
  const disputeEventForRequestTime = await getDisputeForTimestamp(
    dvm,
    clients.hubPoolClient,
    priceRequestTime,
    priceRequestBlock
  );
  let precedingProposeRootBundleEvent: ProposedRootBundle;
  if (disputeEventForRequestTime !== undefined) {
    precedingProposeRootBundleEvent = getDisputedProposal(clients.hubPoolClient, disputeEventForRequestTime);
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
    clients.hubPoolClient,
    config,
    baseSigner,
    fromBlocks,
    toBlocks
  );

  const mainnetBundleEndBlock = getBlockForChain(
    rootBundle.bundleEvaluationBlockNumbers,
    clients.hubPoolClient.chainId,
    dataworker.chainIdListForBundleEvaluationBlockNumbers
  );

  // Get widest possible block range that could be used at time of root bundle proposal.
  const widestPossibleBlockRanges = await getWidestPossibleExpectedBlockRange(
    clients.configStoreClient.getChainIdIndicesForBlock(mainnetBundleEndBlock),
    spokePoolClients,
    getEndBlockBuffers(dataworker.chainIdListForBundleEvaluationBlockNumbers, dataworker.blockRangeEndBlockBuffer),
    clients,
    mainnetBundleEndBlock,
    clients.configStoreClient.getEnabledChains(mainnetBundleEndBlock)
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
  try {
    // This script inherits the TokenClient, and it attempts to update token approvals. The disputer already has the
    // necessary token approvals in place, so use its address. nb. This implies the script can only be used on mainnet.
    const voidSigner = "0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c";
    const baseSigner = await getSigner({ keyType: "void", cleanEnv: true, roAddress: voidSigner });
    await validate(_logger, baseSigner);
  } finally {
    await disconnectRedisClients(logger);
  }
}

// eslint-disable-next-line no-process-exit
void run(Logger).then(async () => process.exit(0));
