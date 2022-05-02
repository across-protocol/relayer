import { config } from "dotenv";
config();

import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";

import { constructRelayerClients, updateRelayerClients } from "../clients";
import { processEndPollingLoop, winston } from "../utils";

let logger: winston.Logger;

export async function runRelayer(_logger: winston.Logger): Promise<void> {
  logger = _logger;
  try {
    const config = new RelayerConfig(process.env);
    logger.info({ at: "Relayer#index", message: "Relayer starting🏃‍♂️", config });

    const relayerClients = await constructRelayerClients(logger, config);

    const relayer = new Relayer(logger, relayerClients);

    logger.debug({ at: "Relayer#index", message: "Relayer components initialized. Starting execution loop" });

    for (;;) {
      await updateRelayerClients(logger, relayerClients);

      await relayer.checkForUnfilledDepositsAndFill();

      await relayerClients.multiCallerClient.executeTransactionQueue();

      if (await processEndPollingLoop(logger, "Relayer", config.pollingDelay)) break;
    }
  } catch (error) {
    logger.error({ at: "Relayer#index", message: "There was an execution error! Re-running loop", error });
    await runRelayer(logger);
  }
}
