import { processEndPollingLoop, winston, config, startupLogLevel, processCrash } from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  constructSpokePoolClientsForPendingRootBundle,
  updateDataworkerClients,
} from "./DataworkerClientHelper";
import { constructSpokePoolClientsForBlockAndUpdate } from "../common";
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
    config.blockRangeEndBlockBuffer
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
  try {
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    for (;;) {
      await updateDataworkerClients(clients);

      // Construct spoke clients used to evaluate and execute leaves from pending root bundle.
      logger[startupLogLevel(config)]({
        at: "Dataworker#index",
        message: "Constructing spoke pool clients for pending root bundle",
      });
      const spokePoolClientsForPendingRootBundle = await constructSpokePoolClientsForPendingRootBundle(
        logger,
        dataworker.chainIdListForBundleEvaluationBlockNumbers,
        clients,
        true
      );
      logger[startupLogLevel(config)]({
        at: "Dataworker#index",
        message: "Constructing spoke pool clients for next root bundle",
      });
      const latestSpokePoolClients = await constructSpokePoolClientsForBlockAndUpdate(
        dataworker.chainIdListForBundleEvaluationBlockNumbers,
        clients,
        logger,
        clients.hubPoolClient.latestBlockNumber
      );

      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled) await dataworker.validatePendingRootBundle(spokePoolClientsForPendingRootBundle);
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });

      if (config.proposerEnabled)
        await dataworker.proposeRootBundle(latestSpokePoolClients, config.rootBundleExecutionThreshold);
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });

      if (config.executorEnabled) {
        await dataworker.executePoolRebalanceLeaves(spokePoolClientsForPendingRootBundle);

        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves(latestSpokePoolClients);
        await dataworker.executeRelayerRefundLeaves(latestSpokePoolClients);
      } else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });

      await clients.multiCallerClient.executeTransactionQueue(!config.sendingTransactionsEnabled);

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    if (await processCrash(logger, "Dataworker", config.pollingDelay, error)) process.exit(1);
    await runDataworker(logger);
  }
}
