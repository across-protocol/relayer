import { config } from "dotenv";
config();

import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";

import { constructRelayerClients, updateRelayerClients } from "../clients";
import { processEndPollingLoop, winston } from "../utils";

export async function runRelayer(logger: winston.Logger): Promise<void> {
  const config = new RelayerConfig(process.env);
  logger.info({ at: "Relayer#index", message: "Relayer starting🏃‍♂️", config });

  const relayerClients = constructRelayerClients(logger, config);

  const relayer = new Relayer(logger, relayerClients);

  logger.debug({ at: "Relayer#index", message: "Relayer components initialized. Starting execution loop" });

  for (;;) {
    await updateRelayerClients(logger, relayerClients);

    await relayer.checkForUnfilledDepositsAndFill();

    await relayerClients.multiCallerClient.executeTransactionQueue();

    if (await processEndPollingLoop(logger, "Relayer", config.pollingDelay)) break;
  }
}
