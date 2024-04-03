import {
  getCurrentTime,
  processEndPollingLoop,
  winston,
  config,
  startupLogLevel,
  Signer,
  disconnectRedisClients,
} from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients, RelayerClients, updateRelayerClients } from "./RelayerClientHelper";
config();
let logger: winston.Logger;

const randomNumber = () => Math.floor(Math.random() * 1_000_000);

export async function runRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const relayerRun = randomNumber();
  const startTime = getCurrentTime();

  logger = _logger;
  const config = new RelayerConfig(process.env);
  let relayerClients: RelayerClients;

  try {
    logger[startupLogLevel(config)]({ at: "Relayer#index", message: "Relayer started 🏃‍♂️", config, relayerRun });
    relayerClients = await constructRelayerClients(logger, config, baseSigner);
    const relayer = new Relayer(await baseSigner.getAddress(), logger, relayerClients, config);

    logger.debug({ at: "Relayer#index", message: "Relayer components initialized. Starting execution loop" });

    for (;;) {
      await updateRelayerClients(relayerClients, config);

      if (!config.skipRelays) {
        const simulate = !config.sendingRelaysEnabled;
        await relayer.checkForUnfilledDepositsAndFill(config.sendingSlowRelaysEnabled, simulate);
      }

      // Unwrap WETH after filling deposits so we don't mess up slow fill logic, but before rebalancing
      // any tokens so rebalancing can take into account unwrapped WETH balances.
      await relayerClients.inventoryClient.unwrapWeth();

      if (!config.skipRebalancing) {
        await relayerClients.inventoryClient.rebalanceInventoryIfNeeded();
      }

      // Clear state from profit and token clients. These are updated on every iteration and should start fresh.
      relayerClients.profitClient.clearUnprofitableFills();
      relayerClients.tokenClient.clearTokenShortfall();

      if (await processEndPollingLoop(logger, "Relayer", config.pollingDelay)) {
        break;
      }
    }
  } finally {
    await disconnectRedisClients(logger);
  }

  const runtime = getCurrentTime() - startTime;
  logger.debug({ at: "Relayer#index", message: `Completed relayer run ${relayerRun} in ${runtime} seconds.` });
}
