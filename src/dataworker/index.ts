import {
  processEndPollingLoop,
  winston,
  config,
  startupLogLevel,
  Signer,
  disconnectRedisClients,
  isDefined,
} from "../utils";
import { spokePoolClientsToProviders } from "../common";
import { BundleDataToPersistToDALayerType, Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  DataworkerClients,
} from "./DataworkerClientHelper";
import { BalanceAllocator } from "../clients/BalanceAllocator";
import { persistDataToArweave } from "./DataworkerUtils";

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
  logger = _logger;
  let loopStart = performance.now();
  const { clients, config, dataworker } = await createDataworker(logger, baseSigner);
  logger.debug({
    at: "Dataworker#index",
    message: `Time to update non-spoke clients: ${(performance.now() - loopStart) / 1000}s`,
  });
  loopStart = performance.now();
  let bundleDataToPersist: BundleDataToPersistToDALayerType | undefined = undefined;
  try {
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    for (;;) {
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
      const dataworkerFunctionLoopTimerStart = performance.now();
      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled) {
        await dataworker.validatePendingRootBundle(spokePoolClients, config.sendingDisputesEnabled, fromBlocks);
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });
      }

      if (config.proposerEnabled) {
        bundleDataToPersist = await dataworker.proposeRootBundle(
          spokePoolClients,
          config.rootBundleExecutionThreshold,
          config.sendingProposalsEnabled,
          fromBlocks
        );
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });
      }

      if (config.executorEnabled) {
        const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

        await dataworker.executePoolRebalanceLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          fromBlocks
        );

        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          fromBlocks
        );
        await dataworker.executeRelayerRefundLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          fromBlocks
        );
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });
      }

      // Define a helper function to persist the bundle data to the DALayer.
      const persistBundle = async () => {
        // Submit the bundle data to persist to the DALayer if persistingBundleData is enabled.
        // Note: The check for `bundleDataToPersist` is necessary for TSC to be happy.
        if (config.persistingBundleData && isDefined(bundleDataToPersist)) {
          await persistDataToArweave(
            clients.arweaveClient,
            bundleDataToPersist,
            logger,
            `bundles-${bundleDataToPersist.bundleBlockRanges}`
          );
        }
      };

      const dataworkerFunctionLoopTimerEnd = performance.now();
      logger.debug({
        at: "Dataworker#index",
        message: `Time to update spoke pool clients and run dataworker function: ${Math.round(
          (dataworkerFunctionLoopTimerEnd - loopStart) / 1000
        )}s`,
        timeToLoadSpokes: Math.round((dataworkerFunctionLoopTimerStart - loopStart) / 1000),
        timeToRunDataworkerFunctions: Math.round(
          (dataworkerFunctionLoopTimerEnd - dataworkerFunctionLoopTimerStart) / 1000
        ),
      });
      loopStart = performance.now();

      // The dataworker loop takes a long-time to run, so if the proposer is enabled, run a final check and early
      // exit if a proposal is already pending.
      const pendingProposal = await clients.hubPoolClient.hubPool.rootBundleProposal();
      if (
        config.proposerEnabled &&
        isDefined(bundleDataToPersist) &&
        pendingProposal.unclaimedPoolRebalanceLeafCount.eq(0)
      ) {
        logger[startupLogLevel(config)]({
          at: "Dataworker#index",
          message: "Exiting early as a proposal is already pending",
        });
        if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) {
          break;
        } else {
          continue;
        }
      }
      // We want to persist the bundle data to the DALayer *AND* execute the multiCall transaction queue
      // in parallel. We want to have both of these operations complete, even if one of them fails.
      const [persistResult, multiCallResult] = await Promise.allSettled([
        persistBundle(),
        clients.multiCallerClient.executeTransactionQueue(),
      ]);

      // If either of the operations failed, log the error.
      if (persistResult.status === "rejected" || multiCallResult.status === "rejected") {
        logger.error({
          at: "Dataworker#index",
          message: "Failed to persist bundle data to the DALayer or execute the multiCall transaction queue",
          persistResult: persistResult.status === "rejected" ? persistResult.reason : undefined,
          multiCallResult: multiCallResult.status === "rejected" ? multiCallResult.reason : undefined,
        });
      }

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) {
        break;
      }
    }
  } finally {
    await disconnectRedisClients(logger);
  }
}
