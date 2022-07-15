import { processEndPollingLoop, winston, config, startupLogLevel, processCrash } from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  updateDataworkerClients,
  spokePoolClientsToProviders,
} from "./DataworkerClientHelper";
import { constructSpokePoolClientsForBlockAndUpdate, updateSpokePoolClients } from "../common";
import { BalanceAllocator } from "../clients/BalanceAllocator";
import { SpokePoolClientsByChain } from "../interfaces";
config();
let logger: winston.Logger;

export async function createDataworker(_logger: winston.Logger) {
  const config = new DataworkerConfig(process.env);
  const clients = await constructDataworkerClients(_logger, config);

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
export async function runDataworker(_logger: winston.Logger): Promise<void> {
  logger = _logger;
  const { clients, config, dataworker } = await createDataworker(logger);
  let spokePoolClients: SpokePoolClientsByChain;
  try {
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    for (;;) {
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

      if (spokePoolClients === undefined) {
        spokePoolClients = await constructSpokePoolClientsForBlockAndUpdate(
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
          config.useCacheForSpokePool ? bundleEndBlockMapping : {}
        );
      } else
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

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    // eslint-disable-next-line no-process-exit
    if (await processCrash(logger, "Dataworker", config.pollingDelay, error)) process.exit(1);

    // todo understand why redisClient isn't GCed automagically.
    logger.debug("Disconnecting from redis server.");
    clients.configStoreClient.redisClient.disconnect();

    await runDataworker(logger);
  }
}
