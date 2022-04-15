import { config } from "dotenv";
import { winston, processEndPollingLoop } from "../utils";
import { Monitor } from "./Monitor";
import { MonitorConfig } from "./MonitorConfig";
import { constructMonitorClients } from "../clients/MonitorClientHelper";

config();

export async function runMonitor(logger: winston.Logger) {
  const config = new MonitorConfig(process.env);
  logger.info({
    at: "AcrossMonitor#index",
    message: "AcrossMonitor started 🔭",
    config,
  });

  const clients = constructMonitorClients(config, logger);
  const acrossMonitor = new Monitor(logger, config, clients);

  for (;;) {
    await acrossMonitor.update();

    // Start bots that are enabled.
    if (config.botModes.utilizationEnabled) await acrossMonitor.checkUtilization();
    else logger.debug({ at: "AcrossMonitor#Utilization", message: "Utilization monitor disabled" });

    if (config.botModes.unknownRootBundleCallersEnabled) await acrossMonitor.checkUnknownRootBundleCallers();
    else
      logger.debug({
        at: "AcrossMonitor#UnknownRootBundleCallers",
        message: "UnknownRootBundleCallers monitor disabled",
      });

    if (await processEndPollingLoop(logger, "Monitor", config.pollingDelay)) break;
  }
}
