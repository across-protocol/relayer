import {
  processEndPollingLoop,
  winston,
  config,
  startupLogLevel,
  Signer,
  disconnectRedisClients,
  isDefined,
  Profiler,
} from "../utils";
import { spokePoolClientsToProviders } from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  DataworkerClients,
} from "./DataworkerClientHelper";
import { BalanceAllocator } from "../clients/BalanceAllocator";
import { PendingRootBundle, BundleData } from "../interfaces";

config();
let logger: winston.Logger;

export async function createDataworker(
  _logger: winston.Logger,
  baseSigner: Signer
): Promise<{
  config: DataworkerConfig;
  clients: DataworkerClients;
  dataworker: Dataworker;
}> {
  const config = new DataworkerConfig(process.env);
  const clients = await constructDataworkerClients(_logger, config, baseSigner);

  const dataworker = new Dataworker(
    _logger,
    config,
    clients,
    clients.configStoreClient.getChainIdIndicesForBlock(),
    config.maxRelayerRepaymentLeafSizeOverride,
    config.maxPoolRebalanceLeafSizeOverride,
    config.blockRangeEndBlockBuffer,
    config.spokeRootsLookbackCount,
    config.bufferToPropose,
    config.forcePropose,
    config.forceProposalBundleRange
  );

  return {
    config,
    clients,
    dataworker,
  };
}

export async function runDataworker(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const profiler = new Profiler({
    at: "Dataworker#index",
    logger: _logger,
  });
  logger = _logger;

  const { clients, config, dataworker } = await profiler.measureAsync(
    createDataworker(logger, baseSigner),
    "createDataworker",
    {
      message: "Time to update non-spoke clients",
    }
  );

  let proposedBundleData: BundleData | undefined = undefined;
  let poolRebalanceLeafExecutionCount = 0;
  try {
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    for (;;) {
      profiler.mark("loopStart");
      // Determine the spoke client's lookback:
      // 1. We initiate the spoke client event search windows based on a start bundle's bundle block end numbers and
      //    how many bundles we want to look back from the start bundle blocks.
      // 2. For example, if the start bundle is 100 and the lookback is 16, then we will set the spoke client event
      //    search window's toBlocks equal to the 100th bundle's block evaluation numbers and the fromBlocks equal
      //    to the 84th bundle's block evaluation numbers.
      // 3. Once we do all the querying, we figure out the earliest block that we’re able to validate per chain. This
      //    is simply equal to the first block queried per chain.
      // 4. If the earliest block we can validate is later than some target fully executed bundle's start blocks,
      //    then extend the SpokePoolClients' lookbacks and update again. Do this up to a specified # of retries.
      //    By dynamically increasing the range of Deposit events to at least cover the target bundle's
      //    start blocks, we can reduce the error rate. This is because of how the disputer and proposer will handle
      //    the case where it can't validate a fill without loading an earlier block.
      // 5. If the bundle we’re trying to validate or propose requires an earlier block, then exit early and
      //    emit an alert. In the dispute flow, this alert should be ERROR level.

      // Get block range for spoke clients using the dataworker fast lookback bundle count.
      const { fromBundle, toBundle, fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(
        config,
        clients,
        dataworker
      );
      logger.debug({
        at: "Dataworker#index",
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
      profiler.mark("dataworkerFunctionLoopTimerStart");
      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled) {
        await dataworker.validatePendingRootBundle(
          spokePoolClients,
          config.sendingTransactionsEnabled,
          fromBlocks,
          // @dev Opportunistically publish bundle data to external storage layer since we're reconstructing it in this
          // process, if user has configured it so.
          config.persistingBundleData
        );
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });
      }

      if (config.proposerEnabled) {
        // Bundle data is defined if and only if there is a new bundle proposal transaction enqueued.
        proposedBundleData = await dataworker.proposeRootBundle(
          spokePoolClients,
          config.rootBundleExecutionThreshold,
          config.sendingTransactionsEnabled,
          fromBlocks
        );
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });
      }

      if (config.l2ExecutorEnabled || config.l1ExecutorEnabled) {
        const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

        if (config.l1ExecutorEnabled) {
          poolRebalanceLeafExecutionCount = await dataworker.executePoolRebalanceLeaves(
            spokePoolClients,
            balanceAllocator,
            config.sendingTransactionsEnabled,
            fromBlocks
          );
        }

        if (config.l2ExecutorEnabled) {
          // Execute slow relays before relayer refunds to give them priority for any L2 funds.
          await dataworker.executeSlowRelayLeaves(
            spokePoolClients,
            balanceAllocator,
            config.sendingTransactionsEnabled,
            fromBlocks
          );
          await dataworker.executeRelayerRefundLeaves(
            spokePoolClients,
            balanceAllocator,
            config.sendingTransactionsEnabled,
            fromBlocks
          );
        }
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });
      }

      // @dev The dataworker loop takes a long-time to run, so if the proposer is enabled, run a final check and early
      // exit if a proposal is already pending. Similarly, the executor is enabled and if there are pool rebalance
      // leaves to be executed but the proposed bundle was already executed, then exit early.
      const pendingProposal: PendingRootBundle = await clients.hubPoolClient.hubPool.rootBundleProposal();

      const proposalCollision = isDefined(proposedBundleData) && pendingProposal.unclaimedPoolRebalanceLeafCount > 0;
      // The pending root bundle that we want to execute has already been executed if its unclaimed leaf count
      // does not match the number of leaves the executor wants to execute, or the pending root bundle's
      // challenge period timestamp is in the future. This latter case is rarer but it can
      // happen if a proposal in addition to the root bundle execution happens in the middle of this executor run.
      const executorCollision =
        poolRebalanceLeafExecutionCount > 0 &&
        (pendingProposal.unclaimedPoolRebalanceLeafCount !== poolRebalanceLeafExecutionCount ||
          pendingProposal.challengePeriodEndTimestamp > clients.hubPoolClient.currentTime);
      if (proposalCollision || executorCollision) {
        logger[startupLogLevel(config)]({
          at: "Dataworker#index",
          message: "Exiting early due to dataworker function collision",
          proposalCollision,
          proposedBundleDataDefined: isDefined(proposedBundleData),
          executorCollision,
          poolRebalanceLeafExecutionCount,
          unclaimedPoolRebalanceLeafCount: pendingProposal.unclaimedPoolRebalanceLeafCount,
          challengePeriodNotPassed: pendingProposal.challengePeriodEndTimestamp > clients.hubPoolClient.currentTime,
          pendingProposal,
        });
      } else {
        await clients.multiCallerClient.executeTxnQueues();
      }
      profiler.mark("dataworkerFunctionLoopTimerEnd");
      profiler.measure("timeToLoadSpokes", {
        message: "Time to load spokes in data worker loop",
        from: "loopStart",
        to: "dataworkerFunctionLoopTimerStart",
      });
      profiler.measure("timeToRunDataworkerFunctions", {
        message: "Time to run data worker functions in data worker loop",
        from: "dataworkerFunctionLoopTimerStart",
        to: "dataworkerFunctionLoopTimerEnd",
      });
      // do we need to add an additional log for the sum of the previous?
      profiler.measure("dataWorkerTotal", {
        message: "Total time taken for dataworker loop",
        from: "loopStart",
        to: "dataworkerFunctionLoopTimerEnd",
      });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) {
        break;
      }
    }
  } finally {
    await disconnectRedisClients(logger);
  }
}
