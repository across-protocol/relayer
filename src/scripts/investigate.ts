import {
  winston,
  config,
  Logger,
  delay,
  getFillsInRange,
  getNetworkName,
  toBN,
  Contract,
  ERC20,
  etherscanLink,
  sortEventsAscending, getSigner,
} from "../utils";
import { updateDataworkerClients } from "../dataworker/DataworkerClientHelper";
import { createDataworker } from "../dataworker";
import { constructSpokePoolClientsForBlockAndUpdate, updateSpokePoolClients } from "../common";

config();
let logger: winston.Logger;

export async function findDeficitBundles(_logger: winston.Logger) {
  logger = _logger;

  const baseSigner = await getSigner();
  const { clients, dataworker } = await createDataworker(logger, baseSigner);
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

  // TODO: Consider moving this to .env
  // This can be updated to restrict the search. Only bundles proposed after this block number of mainnet are examined.
  const startBlockNumber = 0;

  const latestMainnetBlock = hubPoolClient.latestBlockNumber;
  const bundleStartBlocks = Object.fromEntries(
    dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => [chainId, 0])
  );

  const allBundles = sortEventsAscending(hubPoolClient.getProposedRootBundles());
  for (const bundle of allBundles) {
    // Skip all bundles older than search's start or bundle that were not executed.
    if (bundle.blockNumber < startBlockNumber || !hubPoolClient.isRootBundleValid(bundle, latestMainnetBlock)) {
      continue;
    }

    /*
    const bundleIds: { [chainId: number]: number } = {};
    for (const chainId of dataworker.chainIdListForBundleEvaluationBlockNumbers) {
      bundleIds[chainId] = spokePoolClients[chainId]
        .getRootBundleRelays()
        .find((b) => b.relayerRefundRoot === bundle.relayerRefundRoot)
        .rootBundleId;
    }
    */

    const bundleBlockRanges = dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, index) => {
      return [bundleStartBlocks[chainId], bundle.bundleEvaluationBlockNumbers[index].toNumber()];
    });
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
      bundle.blockNumber,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      true
    );

    /*
    const { leaves: allRefundLeaves } = dataworker.buildRelayerRefundRoot(
      bundleBlockRanges,
      spokePoolClients,
      poolRebalanceRoot.leaves,
      poolRebalanceRoot.runningBalances
    );

    // Diff refund leaf against what was actually executed.
    for (const [leafId, leaf] of allRefundLeaves.entries()) {
      const chainId = leaf.chainId;
      const executedLeaf = spokePoolClients[chainId].findRelayerRefundExecutions(bundleIds[chainId], leafId);
      if (!executedLeaf) {
        logger.warn({
          at: "findDeficitBundles",
          message: `Bundle ${bundleIds[chainId]} on ${chainId}: Cannot find executed leaf`,
          leaf,
          executedLeaf,
        });
        continue;
      }
      if (!leaf.amountToReturn.eq(executedLeaf.amountToReturn)) {
        logger.warn({
          at: "findDeficitBundles",
          message: `Bundle ${bundleIds[chainId]} on ${chainId}: Mismatching amountToReturn leaf found`,
          leaf,
          executedLeaf,
        });
      }
    }
     */

    // TODO: Diff rebalance leaves.
    const followingBlockNumber = clients.hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber;
    if (!followingBlockNumber) {
      logger.warn({
        at: "findDeficitBundles",
        message: "Cannot find next bundle",
        bundleTx: bundle.transactionHash,
      });
      continue;
    }
    const executedLeaves = clients.hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);
    const mismatchingLeafs = [];
    for (const leaf of poolRebalanceRoot.leaves) {
      for (const executedLeaf of executedLeaves) {
        if (leaf.leafId == executedLeaf.leafId) {
          const leafRunningBalances = leaf.runningBalances.map((l) => l.toString());
          const executedLeafRunningBalances = executedLeaf.runningBalances.map((l) => l.toString());
          const leafNetSendAmounts = leaf.netSendAmounts.map((l) => l.toString());
          const executedLeafNetSendAmounts = executedLeaf.netSendAmounts.map((l) => l.toString());
          if (JSON.stringify(leafRunningBalances) != JSON.stringify(executedLeafRunningBalances)
            || JSON.stringify(leafNetSendAmounts) != JSON.stringify(executedLeafNetSendAmounts)) {
            mismatchingLeafs.push([leaf, executedLeaf]);
          }
        }
      }
    }

    if (mismatchingLeafs.length > 0) {
      for (const [leaf, executedLeaf] of mismatchingLeafs) {
        logger.warn({
          at: "findDeficitBundles",
          message: "Mismatching leaves found",
          leaf,
          executedLeaf,
        });
      }
    } else {
      logger.info({
        at: "findDeficitBundles",
        message: "No mismatching leaves found",
      });
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
