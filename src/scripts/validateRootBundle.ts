// How to run:
// 1. You might need to set the following environment variables:
//    HUB_CHAIN_ID=1
//    MAX_BLOCK_LOOK_BACK='{"1":0,"10":0,"137":3499,"288":4999,"42161":0}'
//    NODE_URL_1=https://mainnet.infura.io/v3/KEY
//    NODE_URL_10=https://optimism-mainnet.infura.io/v3/KEY
//    NODE_URL_137=https://polygon-mainnet.infura.io/v3/KEY
//    NODE_URL_288=https://mainnet.boba.network/
//    NODE_URL_42161=https://arb-mainnet.g.alchemy.com/v2/KEY
// 2. REQUEST_TIME=1652832060 ts-node ./src/scripts/validateRootBundle.ts --wallet mnemonic

// For devs:
//     Test cases:
//         REQUEST_TIME=1652832060 # Time right after a known valid proposed root bundle
//         REQUEST_TIME=1652301947 # Time right after a known invalid proposed root bundle missing some refunds
//         REQUEST_TIME=1652408987 # Invalid bundle block range, too high
//         REQUEST_TIME=1652385167 # Empty pool rebalance root
//         REQUEST_TIME=1652394287 # Invalid bundle block range length, assuming a valid chain ID list of 5

import { winston, config, startupLogLevel, Logger, delay } from "../utils";
import * as Constants from "../common";
import { updateDataworkerClients } from "../dataworker/DataworkerClientHelper";
import { BlockFinder } from "@uma/sdk";
import { RootBundle } from "../interfaces";
import { getWidestPossibleExpectedBlockRange } from "../dataworker/PoolRebalanceUtils";
import { createDataworker } from "../dataworker";

config();
let logger: winston.Logger;

export async function validate(_logger: winston.Logger) {
  logger = _logger;
  if (!process.env.REQUEST_TIME)
    throw new Error("Must set environment variable 'REQUEST_TIME=<NUMBER>' to disputed price request time");
  const priceRequestTime = Number(process.env.REQUEST_TIME);

  const { clients, config, dataworker } = await createDataworker(logger);
  logger[startupLogLevel(config)]({
    at: "RootBundleValidator",
    message: "Validating most recently proposed root bundle for request time",
    priceRequestTime,
    config,
  });

  // Construct blockfinder to figure out which block corresponds with the disputed price request time.
  const blockFinder = new BlockFinder(
    clients.configStoreClient.configStore.provider.getBlock.bind(clients.configStoreClient.configStore.provider)
  );
  const priceRequestBlock = (await blockFinder.getBlockForTimestamp(priceRequestTime)).number;
  await updateDataworkerClients(clients);
  const precedingProposeRootBundleEvent = clients.hubPoolClient.getMostRecentProposedRootBundle(priceRequestBlock);
  logger.debug({
    at: "RootBundleValidator",
    message: "Found latest ProposeRootBundle event before dispute time",
    priceRequestTime,
    priceRequestBlock,
  });
  const rootBundle: RootBundle = {
    poolRebalanceRoot: precedingProposeRootBundleEvent.poolRebalanceRoot,
    relayerRefundRoot: precedingProposeRootBundleEvent.relayerRefundRoot,
    slowRelayRoot: precedingProposeRootBundleEvent.slowRelayRoot,
    proposer: precedingProposeRootBundleEvent.proposer,
    unclaimedPoolRebalanceLeafCount: precedingProposeRootBundleEvent.poolRebalanceLeafCount,
    challengePeriodEndTimestamp: precedingProposeRootBundleEvent.challengePeriodEndTimestamp,
    bundleEvaluationBlockNumbers: precedingProposeRootBundleEvent.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
    proposalBlockNumber: precedingProposeRootBundleEvent.blockNumber,
  };

  const widestPossibleBlockRanges = await getWidestPossibleExpectedBlockRange(
    Constants.CHAIN_ID_LIST_INDICES,
    clients,
    priceRequestBlock
  );
  logger.debug({
    at: "RootBundleValidator",
    message: "Root bundle end block numbers must be less than latest L2 blocks",
    rootBundleEvaluationBlockNumbers: precedingProposeRootBundleEvent.bundleEvaluationBlockNumbers.map((x) =>
      x.toNumber()
    ),
    latestBlocks: widestPossibleBlockRanges.map((range) => range[1]),
    impliedStartBlocks: widestPossibleBlockRanges.map((range) => range[0]),
  });

  // Validate the event:
  logger.debug({
    at: "RootBundleValidator",
    message: "Validating root bundle",
    rootBundle,
  });
  const { valid, reason } = await dataworker.validateRootBundle(
    config.hubPoolChainId,
    widestPossibleBlockRanges,
    rootBundle
  );

  logger.info({
    at: "RootBundleValidator",
    message: "Validation results",
    rootBundle,
    valid,
    invalidReason: reason,
  });
}

export async function run(_logger: winston.Logger) {
  // Keep trying to validate until it works.
  try {
    await validate(_logger);
  } catch (error) {
    logger.error({ at: "RootBundleValidator", message: "Caught an error, retrying!", error });
    await delay(5);
    await run(Logger);
  }
}

if (require.main === module) {
  run(Logger)
    .then(() => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error({ at: "InfrastructureEntryPoint", message: "There was an error in the main entry point!", error });
      await delay(5);
      await run(Logger);
    });
}
