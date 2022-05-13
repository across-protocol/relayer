import { processEndPollingLoop, winston, delay, getProvider, config, startupLogLevel } from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import { constructDataworkerClients, updateDataworkerClients } from "./DataworkerClientHelper";
config();
let logger: winston.Logger;

export async function runDataworker(_logger: winston.Logger): Promise<void> {
  logger = _logger;
  try {
    const config = new DataworkerConfig(process.env);
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    const clients = await constructDataworkerClients(logger, config);

    const dataworker = new Dataworker(
      logger,
      clients,
      Constants.CHAIN_ID_LIST_INDICES,
      config.maxRelayerRepaymentLeafSizeOverride,
      config.maxPoolRebalanceLeafSizeOverride,
      config.tokenTransferThresholdOverride
    );

    logger.debug({ at: "Dataworker#index", message: "Components initialized. Starting execution loop" });

    for (;;) {
      await updateDataworkerClients(clients);

      await dataworker.proposeRootBundle();

      await clients.multiCallerClient.executeTransactionQueue();

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    logger.error({ at: "Dataworker#index", message: "There was an execution error! Re-running loop", error });
    await delay(5);
    await runDataworker(logger);
  }
}
