import { config } from "dotenv";
config();

import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";

import { constructClients, updateClients } from "../clients";
import { processEndPollingLoop, winston } from "../utils";

export async function runRelayer(logger: winston.Logger): Promise<void> {
  const config = new RelayerConfig(process.env);
  logger.info({ at: "Relayer#index", message: "Relayer starting🏃‍♂️", config });

  const { hubPoolClient, rateModelClient, spokePoolClients, multiCallBundler } = constructClients(logger, config);

  const relayer = new Relayer(logger, spokePoolClients, multiCallBundler);

  logger.debug({ at: "Relayer#index", message: "Relayer components initialized. Starting execution loop" });

  for (;;) {
    await updateClients(logger, hubPoolClient, rateModelClient, spokePoolClients);

    await relayer.checkForUnfilledDepositsAndFill();

    await multiCallBundler.executeTransactionQueue();
    multiCallBundler.clearTransactionQueue();

    if (await processEndPollingLoop(logger, "Relayer", config.pollingDelay)) break;
  }
}
