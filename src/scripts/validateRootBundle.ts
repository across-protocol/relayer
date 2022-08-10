// How to run:
// 1. You might need to set the following environment variables:
//    HUB_CHAIN_ID=1
//    MAX_BLOCK_LOOK_BACK='{"1":0,"10":0,"137":3499,"288":4999,"42161":0}'
//    NODE_URL_1=https://mainnet.infura.io/v3/KEY
//    NODE_URL_10=https://optimism-mainnet.infura.io/v3/KEY
//    NODE_URL_137=https://polygon-mainnet.infura.io/v3/KEY
//    NODE_URL_288=https://mainnet.boba.network/
//    NODE_URL_42161=https://arb-mainnet.g.alchemy.com/v2/KEY
// 2. Example of invalid bundle: REQUEST_TIME=1653594774 ts-node ./src/scripts/validateRootBundle.ts --wallet mnemonic
// 2. Example of valid bundle:   REQUEST_TIME=1653516226 ts-node ./src/scripts/validateRootBundle.ts --wallet mnemonic

import { Wallet, winston, config, getSigner, startupLogLevel, Logger, delay } from "../utils";
import { updateDataworkerClients } from "../dataworker/DataworkerClientHelper";
import { BlockFinder } from "@uma/sdk";
import { PendingRootBundle } from "../interfaces";
import { getWidestPossibleExpectedBlockRange } from "../dataworker/PoolRebalanceUtils";
import { createDataworker } from "../dataworker";
import { getEndBlockBuffers } from "../dataworker/DataworkerUtils";
import { constructSpokePoolClientsForBlockAndUpdate } from "../common";

config();
let logger: winston.Logger;

export async function validate(_logger: winston.Logger, baseSigner: Wallet) {
  logger = _logger;
  if (!process.env.REQUEST_TIME)
    throw new Error("Must set environment variable 'REQUEST_TIME=<NUMBER>' to disputed price request time");
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
  await updateDataworkerClients(clients);
  const precedingProposeRootBundleEvent = clients.hubPoolClient.getMostRecentProposedRootBundle(priceRequestBlock);
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
  const latestFullyExecutedBundleEndBlocks = clients.hubPoolClient.getLatestFullyExecutedRootBundle(
    clients.hubPoolClient.latestBlockNumber
  ).bundleEvaluationBlockNumbers;
  const bundleEndBlockMapping = Object.fromEntries(
    dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, index) => {
      return [chainId, latestFullyExecutedBundleEndBlocks[index].toNumber()];
    })
  );
  const spokePoolClients = await constructSpokePoolClientsForBlockAndUpdate(
    dataworker.chainIdListForBundleEvaluationBlockNumbers,
    clients,
    logger,
    clients.hubPoolClient.latestBlockNumber,
    [
      "FundsDeposited",
      "RequestedSpeedUpDeposit",
      "FilledRelay",
      "EnabledDepositRoute",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ],
    bundleEndBlockMapping
  );

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
  // Keep trying to validate until it works. Failure to get a Wallet is probably not transient.
  const baseSigner: Wallet = await getSigner();
  try {
    await validate(_logger, baseSigner);
  } catch (error) {
    console.error(error);
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
