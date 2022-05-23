import { processEndPollingLoop, winston, delay, config, startupLogLevel } from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import { constructDataworkerClients, updateDataworkerClients } from "./DataworkerClientHelper";
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
  try {
    const { clients, config, dataworker } = await createDataworker(logger);
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    for (;;) {
      await updateDataworkerClients(clients);

      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled) await dataworker.validatePendingRootBundle();
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputed disabled" });

      if (config.proposerEnabled) await dataworker.proposeRootBundle(config.rootBundleExecutionThreshold);
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });

      if (config.executorEnabled) {
        await dataworker.executePoolRebalanceLeaves();

        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves();
  
        await dataworker.executeRelayerRefundLeaves();
      } 
      
      await clients.multiCallerClient.executeTransactionQueue(!config.sendingTransactionsEnabled);

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    logger.error({ at: "Dataworker#index", message: "There was an execution error! Re-running loop", error });
    await delay(5);
    await runDataworker(logger);
  }
}
