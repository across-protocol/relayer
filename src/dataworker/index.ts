import {
  processEndPollingLoop,
  winston,
  config,
  startupLogLevel,
  Wallet,
  getEarliestMatchedFillBlocks,
} from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  updateDataworkerClients,
  spokePoolClientsToProviders,
  constructSpokePoolClientsForFastDataworker,
} from "./DataworkerClientHelper";
import { constructSpokePoolClientsWithStartBlocksAndUpdate } from "../common";
import { BalanceAllocator } from "../clients/BalanceAllocator";
import { SpokePoolClientsByChain } from "../interfaces";
import { getBlockForChain } from "./DataworkerUtils";
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
      // Clear cache so results can be updated with new data.
      dataworker.clearCache();
      await updateDataworkerClients(clients);

      // Grab end blocks for latest fully executed bundle. We can use this block to optimize the dataworker event
      // search by loading partially from the cache and only saving into the cache all blocks older than or equal
      // to the bundle end blocks for the chains. This will let the dataworker's proposal and validation logic
      // to continue to fetch fresh events while allowing the leaf execution methods to use cached logic and overall
      // reduce the number of web3 requests sent.
      const latestFullyExecutedBundleEndBlocks = clients.hubPoolClient.getLatestFullyExecutedRootBundle(
        clients.hubPoolClient.latestBlockNumber
      ).bundleEvaluationBlockNumbers;
      const bundleEndBlockMapping = Object.fromEntries(
        dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, index) => {
          return [chainId, latestFullyExecutedBundleEndBlocks[index].toNumber()];
        })
      );

      // Construct spoke pool clients.
      let spokePoolClients: SpokePoolClientsByChain;
      // Record the latest blocks for each spoke client that we can use to construct root bundles. This is dependent
      // on the fills for the client having matching deposit events on a different client. If a fill cannot be matched
      // with a deposit then we can't construct a root bundle for it.
      let earliestMatchedFillBlocks: { [chainId: number]: number } = {};

      if (config.dataworkerFastLookbackCount > 0) {
        // We'll construct and update the spoke pool clients with a short lookback with an eye to
        // reducing compute time. With the data we load, we need to check if there are any fills that cannot be
        // matched with a deposit in the events loaded by the clients. This would make constructing accurate root
        // bundles potentially impossible. So, we should save the last block for each chain with fills that we can
        // construct or validate root bundles for.

        const nthLatestFullyExecutedBundle = clients.hubPoolClient.getNthFullyExecutedRootBundle(
          config.dataworkerFastLookbackCount
        );
        const nthLatestFullyExecutedBundleEndBlocks = nthLatestFullyExecutedBundle.bundleEvaluationBlockNumbers.map(
          (x) => x.toNumber()
        );
        const startBlocks = Object.fromEntries(
          dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
            return [
              chainId,
              getBlockForChain(
                nthLatestFullyExecutedBundleEndBlocks,
                chainId,
                dataworker.chainIdListForBundleEvaluationBlockNumbers
              ) + 1, // Need to add 1 to bundle end block since bundles begin at previous bundle end blocks + 1
            ];
          })
        );
        logger.debug({
          at: "Dataworker#index",
          message:
            "Setting start blocks for SpokePoolClient equal to bundle evaluation end blocks from Nth latest valid root bundle",
          N: config.dataworkerFastLookbackCount,
          startBlocks,
          nthLatestFullyExecutedBundleTxn: nthLatestFullyExecutedBundle.transactionHash,
        });

        spokePoolClients = await constructSpokePoolClientsForFastDataworker(
          logger,
          clients.configStoreClient,
          config,
          baseSigner,
          startBlocks
        );
        earliestMatchedFillBlocks = getEarliestMatchedFillBlocks(spokePoolClients);

        logger.debug({
          at: "Dataworker#index",
          message:
            "Identified earliest matched fill blocks per chain that we will use to filter root bundles that can be proposed and validated",
          earliestMatchedFillBlocks,
          spokeClientFromBlocks: startBlocks,
        });
      } else {
        // If no fast lookback is configured for dataworker, load events from all time.
        // This will take a long time and possibly cause timeout errors.
        logger.warn({
          at: "Dataworker#index",
          message:
            "Constructing SpokePoolClient and loading events from deployment block. This could take a long time to update (>30 mins)",
        });
        spokePoolClients = await constructSpokePoolClientsWithStartBlocksAndUpdate(
          logger,
          clients.configStoreClient,
          config,
          baseSigner,
          {}, // Empty start block override means start blocks default to SpokePool deployment blocks.
          [
            "FundsDeposited",
            "RequestedSpeedUpDeposit",
            "FilledRelay",
            "EnabledDepositRoute",
            "RelayedRootBundle",
            "ExecutedRelayerRefundRoot",
          ],
          config.useCacheForSpokePool ? bundleEndBlockMapping : {} // Now, use the cache for the longer lookback.
        );
      }

      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled)
        await dataworker.validatePendingRootBundle(
          spokePoolClients,
          config.sendingDisputesEnabled,
          earliestMatchedFillBlocks
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });

      if (config.proposerEnabled)
        await dataworker.proposeRootBundle(
          spokePoolClients,
          config.rootBundleExecutionThreshold,
          config.sendingProposalsEnabled,
          earliestMatchedFillBlocks
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });

      if (config.executorEnabled) {
        const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

        await dataworker.executePoolRebalanceLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          earliestMatchedFillBlocks
        );

        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          earliestMatchedFillBlocks
        );
        await dataworker.executeRelayerRefundLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled,
          earliestMatchedFillBlocks
        );
      } else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });

      await clients.multiCallerClient.executeTransactionQueue();

      logger.debug({ at: "Dataworker#index", message: `Time to loop: ${Date.now() - loopStart}ms` });
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
