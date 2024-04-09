import { config, delay, disconnectRedisClients, getCurrentTime, Signer, startupLogLevel, winston } from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients, updateRelayerClients } from "./RelayerClientHelper";
config();
let logger: winston.Logger;

const randomNumber = () => Math.floor(Math.random() * 1_000_000);

export async function runRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const relayerRun = randomNumber();
  const startTime = getCurrentTime();

  logger = _logger;
  const config = new RelayerConfig(process.env);

  let stop = config.pollingDelay === 0;
  process.on("SIGHUP", () => {
    logger.debug({
      at: "Relayer#run",
      message: "Received SIGHUP, stopping at end of current loop.",
    });
    stop = true;
  });

  logger[startupLogLevel(config)]({ at: "Relayer#run", message: "Relayer started 🏃‍♂️", config, relayerRun });
  const relayerClients = await constructRelayerClients(logger, config, baseSigner);
  const relayer = new Relayer(await baseSigner.getAddress(), logger, relayerClients, config);

  let run = 1;
  try {
    do {
      logger.debug({ at: "relayer#run", message: `Starting relayer execution loop ${run}.` });
      const tLoopStart = performance.now();
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

      const runTime = Math.round((performance.now() - tLoopStart) / 1000);
      logger.debug({
        at: "Relayer#run",
        message: `Completed relayer execution loop ${run++} in ${runTime} seconds.`,
      });

      if (config.pollingDelay > 0) {
        logger.debug({
          at: "relayer#run",
          message: `Waiting polling delay ${config.pollingDelay} s before next loop.`,
        });
        await delay(config.pollingDelay);
      }
    } while (!stop);
  } finally {
    await disconnectRedisClients(logger);
  }

  const runtime = getCurrentTime() - startTime;
  logger.debug({ at: "Relayer#index", message: `Completed relayer run ${relayerRun} in ${runtime} seconds.` });
}
