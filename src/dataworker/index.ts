import { config } from "dotenv";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import * as Constants from "../common";

import { constructDataworkerClients, updateDataworkerClients } from "./DataworkerClientHelper";
import { processEndPollingLoop, winston, delay } from "../utils";

let logger: winston.Logger;

config();

export async function runDataworker(_logger: winston.Logger): Promise<void> {
  logger = _logger;
  try {
    const config = new DataworkerConfig(process.env);
    logger.info({ at: "Dataworker#index", message: "Dataworker starting🏃‍♂️", config });

    const clients = await constructDataworkerClients(logger, config);

    const dataworker = new Dataworker(logger, clients, Constants.CHAIN_ID_LIST_INDICES);

    logger.debug({ at: "Dataworker#index", message: "Components initialized. Starting execution loop" });

    for (;;) {
      await updateDataworkerClients(logger, clients);

      await dataworker.proposeRootBundle();

      await clients.multiCallerClient.executeTransactionQueue(true);

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    logger.error({ at: "Dataworker#index", message: "There was an execution error! Re-running loop", error });
    await delay(5);
    await runDataworker(logger);
  }
}
