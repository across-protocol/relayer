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

    const relayer = new Relayer(logger, relayerClients);

    logger.debug({ at: "Relayer#index", message: "Relayer components initialized. Starting execution loop" });

    for (;;) {
      await updateRelayerClients(relayerClients, config);

      await relayer.checkForUnfilledDepositsAndFill(config.sendingSlowRelaysEnabled);

      await relayerClients.multiCallerClient.executeTransactionQueue(!config.sendingRelaysEnabled);

      await relayerClients.inventoryClient.rebalanceInventoryIfNeeded(config.isDryRun);

      // Clear state from profit and token clients. These are updated on every iteration and should start fresh.
      relayerClients.profitClient.clearUnprofitableFills();
      relayerClients.tokenClient.clearTokenShortfall();

      if (await processEndPollingLoop(logger, "Relayer", config.pollingDelay)) break;
    }
  } catch (error) {
    if (await processCrash(logger, "Relayer", config.pollingDelay, error)) process.exit(1);
    await runRelayer(logger);
  }
}
