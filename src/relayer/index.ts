import { processEndPollingLoop, winston, processCrash, config, startupLogLevel, getSigner } from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients, updateRelayerClients } from "./RelayerClientHelper";
config();
let logger: winston.Logger;

export async function runRelayer(_logger: winston.Logger): Promise<void> {
  logger = _logger;
  const config = new RelayerConfig(process.env);
  let relayerClients;

  try {
    logger[startupLogLevel(config)]({ at: "Relayer#index", message: "Relayer started 🏃‍♂️", config });

    relayerClients = await constructRelayerClients(logger, config);

    const baseSigner = await getSigner();
    const relayer = new Relayer(
      baseSigner.address,
      logger,
      relayerClients,
      config.maxRelayerUnfilledDepositLookBack,
      config.relayerTokens
    );

    logger.debug({ at: "Relayer#index", message: "Relayer components initialized. Starting execution loop" });

    for (;;) {
      await updateRelayerClients(relayerClients);

      await relayer.checkForUnfilledDepositsAndFill(config.sendingSlowRelaysEnabled);

      await relayerClients.multiCallerClient.executeTransactionQueue(!config.sendingRelaysEnabled);

      // Unwrap WETH after filling deposits so we don't mess up slow fill logic, but before rebalancing
      // any tokens so rebalancing can take into account unwrapped WETH balances.
      await relayerClients.inventoryClient.unwrapWeth();

      await relayerClients.inventoryClient.rebalanceInventoryIfNeeded();

      // Clear state from profit and token clients. These are updated on every iteration and should start fresh.
      relayerClients.profitClient.clearUnprofitableFills();
      relayerClients.tokenClient.clearTokenShortfall();

      if (await processEndPollingLoop(logger, "Relayer", config.pollingDelay)) break;
    }
  } catch (error) {
    // eslint-disable-next-line no-process-exit
    if (await processCrash(logger, "Relayer", config.pollingDelay, error)) process.exit(1);

    if (relayerClients !== undefined) {
      // todo understand why redisClient isn't GCed automagically.
      logger.debug("Disconnecting from redis server.");
      relayerClients.configStoreClient.redisClient.disconnect();
    }

    await runRelayer(logger);
  }
}
