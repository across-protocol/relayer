import {
  processEndPollingLoop,
  winston,
  config,
  startupLogLevel,
  Wallet,
  getLatestInvalidBundleStartBlocks,
  getDeploymentBlockNumber,
} from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  updateDataworkerClients,
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  spokePoolClientsToProviders,
} from "./DataworkerClientHelper";
import { BalanceAllocator } from "../clients/BalanceAllocator";
import { SpokePoolClientsByChain } from "../interfaces";
config();
let logger: winston.Logger;

export async function createDataworker(_logger: winston.Logger, baseSigner: Wallet) {
  const config = new DataworkerConfig(process.env);
  const clients = await constructDataworkerClients(_logger, config, baseSigner);

  const dataworker = new Dataworker(
    _logger,
    clients,
    Constants.CHAIN_ID_LIST_INDICES,
    config.maxRelayerRepaymentLeafSizeOverride,
    config.maxPoolRebalanceLeafSizeOverride,
    config.tokenTransferThresholdOverride,
    config.blockRangeEndBlockBuffer,
    config.spokeRootsLookbackCount,
    config.bufferToPropose
  );

  return {
    config,
    clients,
    dataworker,
  };
}
export async function runDataworker(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;
  const { clients, config, dataworker } = await createDataworker(logger, baseSigner);
  try {
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    for (;;) {
      const loopStart = Date.now();
      await updateDataworkerClients(clients);

      // Construct spoke pool clients.
      let spokePoolClients: SpokePoolClientsByChain;

      // Record the latest blocks for each spoke client that we can use to construct root bundles. This is dependent
      // on the fills for the client having matching deposit events on a different client. If a fill cannot be matched
      // with a deposit then we can't construct a root bundle for it.
      let latestInvalidBundleStartBlocks: { [chainId: number]: number } = {};

      // We determine the spoke client's lookback dynamically:
      // 1. We initiate the spoke client event search windows based on a start bundle's bundle block end numbers and
      //    how many bundles we want to look back from the start bundle blocks.
      // 2. For example, if the start bundle is 100 and the lookback is 16, then we will set the spoke client event
      //    search window's toBlocks equal to the 100th bundle's block evaluation numbers and the fromBlocks equal
      //    to the 84th bundle's block evaluation numbers.
      // 3. Once we do all the querying, we figure out the earliest block that we’re able to validate per chain.
      //    This logic can be found in `getLatestInvalidBundleStartBlocks()`
      // 4. If the earliest block we can validate is later than some target fully executed bundle's start blocks,
      //    then extend the SpokePoolClients' lookbacks and update again. Do this up to a specified # of retries.
      //    By dynamically increasing the range of Deposit events to at least cover the target bundle's
      //    start blocks, we can reduce the error rate. This is because of how the disputer and proposer will handle
      //    the case where it can't validate a fill without loading an earlier block.
      // 5. If the bundle we’re trying to validate or propose requires an earlier block, then exit early and
      //    emit an alert. In the dispute flow, this alert should be ERROR level.

      // The following code sets the target bundle's start blocks that we'll use as a threshold for determining
      // whether to expand the lookback dynamically via a retry.
      // Note: The reason why we pass -(2 + config.spokeRootsLookbackCount) into the function below is because we
      // want to get the start blocks of the root bundle that is (spokeRootsLookbackCount) bundles from being
      // from the latest bundle and we start with -2 because -1 would get that target spoke root's end blocks,
      // not its start blocks.
      const nthFullyExecutedBundle = clients.hubPoolClient.getNthFullyExecutedRootBundle(
        -(2 + config.spokeRootsLookbackCount)
      );
      const nthFullyExecutedBundleEndBlocks = nthFullyExecutedBundle?.bundleEvaluationBlockNumbers;
      // Note: If bundle doesn't exist, then use the deployment blocks as the start blocks.
      const bundleStartBlockMapping = Object.fromEntries(
        dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, index) => {
          return [
            chainId,
            nthFullyExecutedBundleEndBlocks
              ? nthFullyExecutedBundleEndBlocks[index].toNumber() + 1
              : getDeploymentBlockNumber("SpokePool", chainId),
          ];
        })
      );

      // Each loop iteration constructs spoke clients using a lookback and sees if we can query old enough events
      // to cover the target bundle range determined above (i.e. the bundle after the nthFullyExecutedBundle).
      const customConfig = { ...config };
      for (let i = 0; i <= config.dataworkerFastLookbackRetryCount; i++) {
        // Get block range for spoke clients using the dataworker fast lookback bundle count.
        const { fromBundle, toBundle, fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(
          customConfig,
          clients,
          dataworker
        );
        logger.debug({
          at: "Dataworker#index",
          message:
            "Setting start blocks for SpokePoolClient equal to bundle evaluation end blocks from Nth latest valid root bundle",
          dataworkerFastStartBundle: customConfig.dataworkerFastStartBundle,
          dataworkerFastLookbackRetryCount: customConfig.dataworkerFastLookbackRetryCount,
          dataworkerFastLookbackRetryMultiplier: customConfig.dataworkerFastLookbackRetryMultiplier,
          retriesMade: i,
          dataworkerFastLookbackCount: customConfig.dataworkerFastLookbackCount,
          fromBlocks,
          toBlocks,
          fromBundleTxn: fromBundle?.transactionHash,
          toBundleTxn: toBundle?.transactionHash,
        });
        spokePoolClients = await constructSpokePoolClientsForFastDataworker(
          logger,
          clients.configStoreClient,
          customConfig,
          baseSigner,
          fromBlocks,
          toBlocks
        );

        // We need to check if there are any queried Fills that cannot possibly be
        // matched with a deposit in the Deposit events loaded by the clients. This would make constructing accurate
        // root bundles impossible. So, we should save the last block for each chain with fills that we can
        // construct or validate root bundles for.
        latestInvalidBundleStartBlocks = getLatestInvalidBundleStartBlocks(spokePoolClients);

        // Now that we have updated the event range fromBlocks for each chain with the latest start blocks we can
        // construct bundles with, we can determine whether we need to run another loop and create new spoke clients
        // with longer lookbacks. This will occur if the latest start block we can use to construct a bundle are
        // greater than the target bundle's start blocks. This basically means we haven't loaded enough data to execute
        // the (N=config.spokeRootsLookbackCount)th bundle.
        if (
          Object.entries(latestInvalidBundleStartBlocks).some(([chainId, invalidBundleStartBlock]) => {
            return invalidBundleStartBlock > bundleStartBlockMapping[chainId];
          })
        ) {
          // Overwrite fast lookback count.
          customConfig.dataworkerFastLookbackCount *= config.dataworkerFastLookbackRetryMultiplier;

          // !!Note: This is a very inefficient algorithm as it requeries all events from the new fromBlocks to the
          // same toBlocks. Better algorithms would be:
          // - Re-updating SpokePoolClients only from new fromBlocks to old fromBlocks. Challenge here is to add a
          //   a utility function to SpokePoolClient to enable querying older events and inserting them correctly
          //   into the already-populated arrays of events.
          // - Only increase the lookback for the SpokePoolClient that will decrease the invalidBundleStartBlock
          //   the most.
          logger.debug({
            at: "Dataworker#index",
            message:
              "latest invalid bundle start blocks are later than next validated bundle's start blocks. Will increase update range and retry 😬",
            latestInvalidBundleStartBlocks,
            bundleStartBlockMapping: bundleStartBlockMapping,
            nthBundle: nthFullyExecutedBundle.transactionHash,
            n: -(2 + config.spokeRootsLookbackCount),
            oldDataworkerFastLookbackCount: config.dataworkerFastLookbackCount,
            newDataworkerFastLookbackCount: customConfig.dataworkerFastLookbackCount,
          });
        } else {
          logger.debug({
            at: "Dataworker#index",
            message:
              "Identified latest invalid bundle start blocks per chain that we will use to filter root bundles that can be proposed and validated",
            latestInvalidBundleStartBlocks,
            bundleStartBlockMapping: bundleStartBlockMapping,
            nthBundle: nthFullyExecutedBundle.transactionHash,
            n: -(2 + config.spokeRootsLookbackCount),
            fromBlocks,
            toBlocks,
          });
          break;
        }
      }

      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled)
        await dataworker.validatePendingRootBundle(
          spokePoolClients,
          config.sendingDisputesEnabled,
          latestInvalidBundleStartBlocks
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });

      if (config.proposerEnabled)
        await dataworker.proposeRootBundle(
          spokePoolClients,
          config.rootBundleExecutionThreshold,
          config.sendingProposalsEnabled,
          latestInvalidBundleStartBlocks
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });

      if (config.executorEnabled) {
        const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

        await dataworker.executePoolRebalanceLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          latestInvalidBundleStartBlocks
        );

        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          latestInvalidBundleStartBlocks
        );
        await dataworker.executeRelayerRefundLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          latestInvalidBundleStartBlocks
        );
      } else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });

      await clients.multiCallerClient.executeTransactionQueue();

      logger.debug({ at: "Dataworker#index", message: `Time to loop: ${(Date.now() - loopStart) / 1000}s` });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    if (clients.configStoreClient.redisClient !== undefined) {
      // todo understand why redisClient isn't GCed automagically.
      logger.debug("Disconnecting from redis server.");
      clients.configStoreClient.redisClient.disconnect();
    }

    throw error;
  }
}
