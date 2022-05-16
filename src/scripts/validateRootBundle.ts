// How to run:
// 1. You might need to set the following environment variables:
//    HUB_CHAIN_ID=1
//    MAX_BLOCK_LOOK_BACK='{"1":0,"10":0,"137":3499,"288":4999,"42161":0}'
//    NODE_URL_1=https://mainnet.infura.io/v3/KEY
//    NODE_URL_10=https://optimism-mainnet.infura.io/v3/KEY
//    NODE_URL_137=https://polygon-mainnet.infura.io/v3/KEY
//    NODE_URL_288=https://mainnet.boba.network/
//    NODE_URL_42161=https://arb-mainnet.g.alchemy.com/v2/KEY
// 2. REQUEST_TIME=1652726987 ts-node ./src/scripts/validateRootBundle.ts --wallet mnemonic

// For devs:
//     Test cases:
//         REQUEST_TIME=1652726987 # Time right after a known valid proposed root bundle
import { winston, config, startupLogLevel, Logger } from "../utils";
import * as Constants from "../common";
import { Dataworker } from "../dataworker/Dataworker";
import { DataworkerConfig } from "../dataworker/DataworkerConfig";
import { constructDataworkerClients, updateDataworkerClients } from "../dataworker/DataworkerClientHelper";
import { BlockFinder } from "@uma/sdk";
import { DataworkerClients } from "../dataworker/DataworkerClientHelper";
import { RootBundle } from "../interfaces";
import { getWidestPossibleExpectedBlockRange } from "../dataworker/PoolRebalanceUtils";

config();
let logger: winston.Logger;

export async function run(_logger: winston.Logger): Promise<boolean> {
  logger = _logger;
  if (!process.env.REQUEST_TIME)
    throw new Error("Must set environment variable 'REQUEST_TIME=<NUMBER>' to disputed price request time");
  const priceRequestTime = Number(process.env.REQUEST_TIME);

  const config = new DataworkerConfig(process.env);
  logger[startupLogLevel(config)]({
    at: "RootBundleValidator",
    message: "Validating most recently proposed root bundle for request time",
    priceRequestTime,
    config,
  });

  const clients: DataworkerClients = await constructDataworkerClients(logger, config);

  const dataworker = new Dataworker(
    logger,
    clients,
    Constants.CHAIN_ID_LIST_INDICES,
    config.maxRelayerRepaymentLeafSizeOverride,
    config.maxPoolRebalanceLeafSizeOverride,
    config.tokenTransferThresholdOverride,
    config.blockRangeEndBlockBuffer
  );

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
  const isValid = await dataworker.validateRootBundle(
    config.hubPoolChainId,
    widestPossibleBlockRanges,
    rootBundle,
    false
  );

  logger.info({
    at: "RootBundleValidator",
    message: "Root bundle is valid",
    rootBundle,
    isValid,
  });

  return isValid;
}

if (require.main === module) {
  run(Logger)
    .then(() => {
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error({ at: "RootBundleValidator", message: "Caught an error!", error });
    });
}
