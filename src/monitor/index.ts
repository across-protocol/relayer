import { winston, processEndPollingLoop, processCrash, config, startupLogLevel } from "../utils";
import { Monitor } from "./Monitor";
import { MonitorConfig } from "./MonitorConfig";
import { constructMonitorClients } from "./MonitorClientHelper";
config();
let logger: winston.Logger;

export async function runMonitor(_logger: winston.Logger) {
  logger = _logger;
  const config = new MonitorConfig(process.env);
  let clients;

  try {
    logger[startupLogLevel(config)]({ at: "AcrossMonitor#index", message: "Monitor started 🔭", config });

    clients = await constructMonitorClients(config, logger);
    const acrossMonitor = new Monitor(logger, config, clients);

    for (;;) {
      await acrossMonitor.update();

      if (config.botModes.utilizationEnabled) await acrossMonitor.checkUtilization();
      else logger.debug({ at: "AcrossMonitor", message: "Utilization monitor disabled" });

      if (config.botModes.unknownRootBundleCallersEnabled) await acrossMonitor.checkUnknownRootBundleCallers();
      else logger.debug({ at: "AcrossMonitor", message: "UnknownRootBundleCallers monitor disabled" });

      if (config.botModes.unknownRelayerCallersEnabled) await acrossMonitor.checkUnknownRelayers();
      else logger.debug({ at: "AcrossMonitor", message: "UnknownRelayerCallers monitor disabled" });

      if (config.botModes.reportEnabled) {
        await acrossMonitor.reportRelayerBalances();
        await acrossMonitor.reportUnfilledDeposits();
      } else {
        logger.debug({ at: "AcrossMonitor", message: "Report disabled" });
      }

      if (config.botModes.balancesEnabled) await acrossMonitor.checkBalances();
      else logger.debug({ at: "AcrossMonitor", message: "CheckBalances monitor disabled" });

      if (await processEndPollingLoop(logger, "Monitor", config.pollingDelay)) break;
    }
  } catch (error) {
    // eslint-disable-next-line no-process-exit
    if (await processCrash(logger, "Monitor", config.pollingDelay, error)) process.exit(1);

    if (clients !== undefined) {
      // todo understand why redisClient isn't GCed automagically.
      logger.debug("Disconnecting from redis server.");
      clients.configStoreClient.redisClient.disconnect();
    }

    await runMonitor(logger);
  }
}
