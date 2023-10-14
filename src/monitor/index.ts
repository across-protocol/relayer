import { winston, processEndPollingLoop, config, startupLogLevel, Wallet, disconnectRedisClients } from "../utils";
import { Monitor } from "./Monitor";
import { MonitorConfig } from "./MonitorConfig";
import { constructMonitorClients } from "./MonitorClientHelper";
config();
let logger: winston.Logger;

export async function runMonitor(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;
  const config = new MonitorConfig(process.env);
  let clients;

  try {
    logger[startupLogLevel(config)]({ at: "Monitor#index", message: "Monitor started 🔭", config });

    clients = await constructMonitorClients(config, logger, baseSigner);
    const acrossMonitor = new Monitor(logger, config, clients);

    for (;;) {
      const loopStart = Date.now();

      await acrossMonitor.update();

      if (config.botModes.utilizationEnabled) {
        await acrossMonitor.checkUtilization();
      } else {
        logger.debug({ at: "Monitor#index", message: "Utilization monitor disabled" });
      }

      if (config.botModes.unknownRootBundleCallersEnabled) {
        await acrossMonitor.checkUnknownRootBundleCallers();
      } else {
        logger.debug({ at: "Monitor#index", message: "UnknownRootBundleCallers monitor disabled" });
      }

      if (config.botModes.unknownRelayerCallersEnabled) {
        await acrossMonitor.checkUnknownRelayers();
      } else {
        logger.debug({ at: "Monitor#index", message: "UnknownRelayerCallers monitor disabled" });
      }

      if (config.botModes.stuckRebalancesEnabled) {
        await acrossMonitor.checkStuckRebalances();
      } else {
        logger.debug({ at: "Monitor#index", message: "StuckRebalances monitor disabled" });
      }

      if (config.botModes.reportEnabled) {
        await acrossMonitor.reportRelayerBalances();
        await acrossMonitor.reportUnfilledDeposits();
      } else {
        logger.debug({ at: "AcrossMonitor", message: "Report disabled" });
      }

      if (config.botModes.refillBalancesEnabled) {
        await acrossMonitor.refillBalances();
      } else {
        logger.debug({ at: "Monitor#index", message: "Refiller disabled" });
      }

      if (config.botModes.balancesEnabled) {
        await acrossMonitor.checkBalances();
      } else {
        logger.debug({ at: "Monitor#index", message: "CheckBalances monitor disabled" });
      }

      await clients.multiCallerClient.executeTransactionQueue();

      logger.debug({ at: "Monitor#index", message: `Time to loop: ${(Date.now() - loopStart) / 1000}s` });

      if (await processEndPollingLoop(logger, "Monitor#index", config.pollingDelay)) {
        break;
      }
    }
  } catch (error) {
    await disconnectRedisClients(logger);
    throw error;
  }
}
