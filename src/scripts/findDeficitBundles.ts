import { winston, config, Logger, delay, getFillsInRange } from "../utils";
import { updateDataworkerClients } from "../dataworker/DataworkerClientHelper";
import { createDataworker } from "../dataworker";
import { constructSpokePoolClientsForBlockAndUpdate, updateSpokePoolClients } from "../common";

config();
let logger: winston.Logger;

export async function findDeficitBundles(_logger: winston.Logger) {
  logger = _logger;

  const { clients, dataworker } = await createDataworker(logger);
  await updateDataworkerClients(clients);

  const hubPoolClient = clients.hubPoolClient;
  const spokePoolClients = await constructSpokePoolClientsForBlockAndUpdate(
    dataworker.chainIdListForBundleEvaluationBlockNumbers,
    clients,
    logger,
    hubPoolClient.latestBlockNumber,
    [
      "FundsDeposited",
      "RequestedSpeedUpDeposit",
      "FilledRelay",
      "EnabledDepositRoute",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ]
  );
  await updateSpokePoolClients(spokePoolClients);

  const latestMainnetBlock = hubPoolClient.latestBlockNumber;
  const bundleStartBlocks = Object.fromEntries(
    dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => [chainId, 0])
  );
  for (const bundle of hubPoolClient.getProposedRootBundles()) {
    // Skip all bundles that were not executed.
    if (!hubPoolClient.isRootBundleValid(bundle, latestMainnetBlock)) continue;

    const bundleBlockRanges = dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, index) => {
      return [bundleStartBlocks[chainId], bundle.bundleEvaluationBlockNumbers[index].toNumber()];
    });
    // Reconstruct the bundle, so we can figure out if any refund leaves were not executed in time.
    const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = clients.bundleDataClient.loadData(
      bundleBlockRanges,
      spokePoolClients
    );
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      bundleBlockRanges,
      dataworker.chainIdListForBundleEvaluationBlockNumbers
    );
    const poolRebalanceRoot = dataworker._getPoolRebalanceRoot(
      bundleBlockRanges,
      hubPoolClient.latestBlockNumber,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      true
    );
    const { leaves: allRefundLeaves } = dataworker.buildRelayerRefundRoot(
      bundleBlockRanges,
      fillsToRefund,
      poolRebalanceRoot.leaves,
      poolRebalanceRoot.runningBalances
    );

    // Find out if there are any unexecuted refund leaves by the next bundle proposal.
    const nextBundleStart = hubPoolClient.getFollowingRootBundle(bundle) || hubPoolClient.latestBlockNumber;
    for (const chainId of dataworker.chainIdListForBundleEvaluationBlockNumbers) {
      const spokePoolClient = spokePoolClients[chainId];
      // Bundle id is unique on each chain.
      const matchingBundle = spokePoolClient
        .getRootBundleRelays()
        .find((b) => b.relayerRefundRoot === bundle.relayerRefundRoot);
      // Some bundles do not have refunds on all chains.
      if (matchingBundle === undefined) continue;
      const bundleId = matchingBundle.rootBundleId;

      const executedRefundLeaves = new Set();
      for (const refundExecution of spokePoolClient.getRelayerRefundExecutions()) {
        // Stop looking if we have examined all refund executions before next bundle start.
        if (refundExecution.blockNumber > nextBundleStart) break;
        if (refundExecution.rootBundleId === bundleId) {
          executedRefundLeaves.add(refundExecution.leafId);
        }
      }

      const unexecutedLeaves = [];
      for (const leaf of allRefundLeaves) {
        if (leaf.chainId === chainId && !executedRefundLeaves.has(leaf.leafId)) {
          unexecutedLeaves.push(leaf);
        }
      }

      logger.warn({
        at: "findDeficitBundles",
        message: "All rebalance and refund leaves",
        allRefundLeaves,
      });
      if (unexecutedLeaves.length > 0) {
        logger.warn({
          at: "findDeficitBundles",
          message: "Found unexecuted leaves",
          poolRebalanceRoot,
          unexecutedLeaves,
        });
      }
    }
  }
}

export async function run(_logger: winston.Logger) {
  // Keep trying to validate until it works.
  try {
    await findDeficitBundles(_logger);
  } catch (error) {
    console.error(error);
    logger.error({ at: "findDeficitBundles", message: "Caught an error, retrying!", error });
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
