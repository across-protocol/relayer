import { processEndPollingLoop, winston, config, startupLogLevel, processCrash, Wallet } from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  updateDataworkerClients,
  spokePoolClientsToProviders,
} from "./DataworkerClientHelper";
import { constructSpokePoolClientsWithLookback, updateSpokePoolClients } from "../common";
import { BalanceAllocator } from "../clients/BalanceAllocator";
import { Deposit, SpokePoolClientsByChain } from "../interfaces";
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

      // We first updated the spoke pool clients with a limited lookback. We now need to check whether we should
      // actually load more data. We only need older data only if there is a fill in the data that completed
      // a partially filled deposit (i.e. it wasn't the first fill for a deposit), and the first fill cannot be
      // found within the loaded event pool.
      let shouldUpdateWithLongerLookback = false;

      // On each loop, double the lookback length.
      const lookbackMultiplier = 1;
      do {
        for (const chainId of Object.keys(config.maxRelayerLookBack)) {
          config.maxRelayerLookBack[chainId] *= lookbackMultiplier;
        }
        logger.debug({
          at: "Dataworker#index",
          message: "Using lookback for SpokePoolClient",
          lookbackConfig: config.maxRelayerLookBack,
        });
        spokePoolClients = await constructSpokePoolClientsWithLookback(
          logger,
          clients.configStoreClient,
          config,
          baseSigner,
          config.maxRelayerLookBack
        );
        await updateSpokePoolClients(
          spokePoolClients,
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
        for (const originChainId of Object.keys(spokePoolClients)) {
          for (const destChainId of Object.keys(spokePoolClients)) {
            if (originChainId === destChainId) continue;
            spokePoolClients[destChainId]
              .getFillsForOriginChain(Number(originChainId))
              .filter((fill) => fill.totalFilledAmount.eq(fill.amount) && !fill.fillAmount.eq(fill.amount))
              .forEach((fill) => {
                if (shouldUpdateWithLongerLookback) return;
                const matchedDeposit: Deposit = spokePoolClients[originChainId].getDepositForFill(fill);
                if (!matchedDeposit) {
                  shouldUpdateWithLongerLookback = true;
                }
              });
            if (shouldUpdateWithLongerLookback) break;
          }
          if (shouldUpdateWithLongerLookback) break;
        }
      } while (shouldUpdateWithLongerLookback);

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
