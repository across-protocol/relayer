import { winston, processEndPollingLoop, processCrash, config, startupLogLevel } from "../utils";
import { Monitor } from "./Monitor";
import { MonitorConfig } from "./MonitorConfig";
import { constructMonitorClients } from "./MonitorClientHelper";
config();
let logger: winston.Logger;

export async function runMonitor(_logger: winston.Logger) {
  logger = _logger;
  const config = new MonitorConfig(process.env);
  try {
    logger[startupLogLevel(config)]({ at: "AcrossMonitor#index", message: "Monitor started 🔭", config });

    const clients = await constructMonitorClients(config, logger);
    const acrossMonitor = new Monitor(logger, config, clients);

    for (;;) {
      await acrossMonitor.update();

      if (config.botModes.utilizationEnabled) await acrossMonitor.checkUtilization();
      else logger.debug({ at: "AcrossMonitor", message: "Utilization monitor disabled" });

      if (config.botModes.unknownRootBundleCallersEnabled) await acrossMonitor.checkUnknownRootBundleCallers();
      else logger.debug({ at: "AcrossMonitor", message: "UnknownRootBundleCallers monitor disabled" });

      if (config.botModes.unknownRelayerCallersEnabled) await acrossMonitor.checkUnknownRelayers();
      else logger.debug({ at: "AcrossMonitor", message: "UnknownRelayerCallers monitor disabled" });

      if (config.botModes.reportEnabled) await acrossMonitor.reportRelayerBalances();
      else logger.debug({ at: "AcrossMonitor", message: "RelayerBalances monitor disabled" });

      if (await processEndPollingLoop(logger, "Monitor", config.pollingDelay)) break;
    }
  } catch (error) {
    if (await processCrash(logger, "Monitor", config.pollingDelay, error)) process.exit(1);
    await runMonitor(logger);
  }
}
