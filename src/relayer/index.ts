import { processEndPollingLoop, winston, processCrash, config, startupLogLevel } from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients, updateRelayerClients } from "./RelayerClientHelper";
config();
let logger: winston.Logger;

export async function runRelayer(_logger: winston.Logger): Promise<void> {
  logger = _logger;
  const config = new RelayerConfig(process.env);
  try {
    logger[startupLogLevel(config)]({ at: "Relayer#index", message: "Relayer started 🏃‍♂️", config });

    const relayerClients = await constructRelayerClients(logger, config);

    const relayer = new Relayer(logger, relayerClients, config.repaymentChainIdForToken);

    logger.debug({ at: "Relayer#index", message: "Relayer components initialized. Starting execution loop" });

    for (;;) {
      await updateRelayerClients(relayerClients);

      await relayer.checkForUnfilledDepositsAndFill();

      await relayerClients.multiCallerClient.executeTransactionQueue();

      if (await processEndPollingLoop(logger, "Relayer", config.pollingDelay)) break;
    }
  } catch (error) {
    if (await processCrash(logger, "Relayer", config.pollingDelay, error)) process.exit(1);
    await runRelayer(logger);
  }
}
