import {
  processEndPollingLoop,
  winston,
  config,
  startupLogLevel,
  Wallet,
  allFillsHaveMatchingDeposits,
} from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  updateDataworkerClients,
  spokePoolClientsToProviders,
} from "./DataworkerClientHelper";
import { constructSpokePoolClientsWithLookbackAndUpdate } from "../common";
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
  let spokePoolClients: SpokePoolClientsByChain;
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

      if (Object.keys(config.dataworkerFastLookback).length > 0) {
        // We'll optimistically construct and update the spoke pool clients with a short lookback with an eye to
        // reducing compute time. With the data we load, we need to check if there are any fills that completed
        // a partially filled deposit (i.e. it wasn't the first fill for a deposit) that cannot be found in the data. This
        // would make constructing accurate slow relay root bundles potentially impossible so we will have to load
        // more data.

        // If we need to extend the lookback window to find the deposit matching a partial fill, then ideally we should
        // increase the window exactly as much as needed to find the deposit, but we have no choice but to iteratively
        // guess and check. If we were to extend the lookback window by 25% and the default lookback
        // window is 4 days old, then this would extend the lookback another day. If we assume that deposits are never
        // more than 24 hours older than the partial fill, then its highly likely that the new lookback will include the
        // fill. However, there is a chance that the new lookback captures a new partial fill at the beginning of the
        // lookback window whose deposit is older than the lookback. This is unlikely because partial fills are expected
        // to be rare in the near term.

        // For the above reasoning, the default lookback window is set to 4 days and default lookback multiplier
        // is 25%.
        for (let i = 0; i < config.dataworkerFastRetryCount; i++) {
          logger.debug({
            at: "Dataworker#index",
            message: "Using lookback for SpokePoolClient",
            dataworkerFastLookback: config.dataworkerFastLookback,
            dataworkerFastLookbackMultiplier: config.dataworkerFastLookbackMultiplier,
          });
          spokePoolClients = await constructSpokePoolClientsWithLookbackAndUpdate(
            logger,
            clients.configStoreClient,
            config,
            baseSigner,
            config.dataworkerFastLookback,
            [
              "FundsDeposited",
              "RequestedSpeedUpDeposit",
              "FilledRelay",
              "EnabledDepositRoute",
              "RelayedRootBundle",
              "ExecutedRelayerRefundRoot",
            ],
            config.useCacheForSpokePool ? bundleEndBlockMapping : {}
          );

          // For every partial fill that completed a deposit in the event search window, match it with its deposit.
          // If the deposit isn't in the window, then break and extend the window.
          if (!allFillsHaveMatchingDeposits(spokePoolClients)) {
            logger.warn({
              at: "Dataworker#index",
              message:
                "Cannot find deposit matching partial fill that completed a full, extending lookback window and reinstantiating SpokePoolClient",
              lookbackConfig: config.dataworkerFastLookback,
            });
            spokePoolClients = undefined;
            // Increase lookback for next retry.
            for (const chainId of Object.keys(config.dataworkerFastLookback)) {
              config.dataworkerFastLookback[chainId] *= Math.ceil(config.dataworkerFastLookbackMultiplier);
            }
          } else {
            break;
          }
        }
      }

      // If we have gotten unlucky and still are finding partial fills without matching deposits within the lookback
      // window, then load events for all history. This will take a long time and possibly cause timeout errors.
      if (spokePoolClients === undefined) {
        logger.warn({
          at: "Dataworker#index",
          message:
            "Constructing SpokePoolClient and loading events from deployment block. This could take a long time to update (>30 mins)",
        });
        spokePoolClients = await constructSpokePoolClientsWithLookbackAndUpdate(
          logger,
          clients.configStoreClient,
          config,
          baseSigner,
          {}, // Empty lookback config means lookback from SpokePool deployment block.
          [
            "FundsDeposited",
            "RequestedSpeedUpDeposit",
            "FilledRelay",
            "EnabledDepositRoute",
            "RelayedRootBundle",
            "ExecutedRelayerRefundRoot",
          ],
          config.useCacheForSpokePool ? bundleEndBlockMapping : {}
        );
      }

      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled)
        await dataworker.validatePendingRootBundle(spokePoolClients, config.sendingDisputesEnabled);
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });

      if (config.proposerEnabled)
        await dataworker.proposeRootBundle(
          spokePoolClients,
          config.rootBundleExecutionThreshold,
          config.sendingProposalsEnabled
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });

      if (config.executorEnabled) {
        const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

        await dataworker.executePoolRebalanceLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled
        );

        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves(spokePoolClients, balanceAllocator, config.sendingExecutionsEnabled);
        await dataworker.executeRelayerRefundLeaves(
          spokePoolClients,
          balanceAllocator,
          config.sendingExecutionsEnabled
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
