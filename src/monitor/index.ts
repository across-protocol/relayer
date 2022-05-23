import { winston, processEndPollingLoop, delay, config, startupLogLevel } from "../utils";
import { Monitor } from "./Monitor";
import { MonitorConfig } from "./MonitorConfig";
import { constructMonitorClients } from "../clients/MonitorClientHelper";
config();
let logger: winston.Logger;

export async function runMonitor(_logger: winston.Logger) {
  logger = _logger;
  try {
    const config = new MonitorConfig(process.env);
    logger[startupLogLevel(config)]({ at: "AcrossMonitor#index", message: "Monitor started 🔭", config });

    const clients = await constructMonitorClients(config, logger);
    const acrossMonitor = new Monitor(logger, config, clients);

    for (;;) {
      await acrossMonitor.update();

      if (config.botModes.utilizationEnabled) await acrossMonitor.checkUtilization();
      else logger.debug({ at: "AcrossMonitor", message: "Utilization monitor disabled" });

      if (config.botModes.unknownRootBundleCallersEnabled) await acrossMonitor.checkUnknownRootBundleCallers();
      else logger.debug({ at: "AcrossMonitor", message: "UnknownRootBundleCallers monitor disabled" });

      if (await processEndPollingLoop(logger, "Monitor", config.pollingDelay)) break;
    }
  } catch (error) {
    logger.error({ at: "Monitor#index", message: "There was an execution error! Re-running loop", error });
    await delay(5);
    await runMonitor(logger);
  }
}
