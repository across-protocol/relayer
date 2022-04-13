import { config } from "dotenv";
import { winston, delay, getProvider, getSigner } from "../utils";
import { AcrossMonitor } from "./AcrossMonitor";
import { AcrossMonitorConfig } from "./AcrossMonitorConfig";
import retry from "async-retry";
import { HubPoolClient } from "../clients";
import { getDeployedContract } from "../utils/ContractUtils";
import { SpokePool } from "@across-protocol/contracts-v2";

config();

export async function runMonitor(logger: winston.Logger) {
  const config = new AcrossMonitorConfig(process.env);
  // If pollingDelay === 0 then the bot is running in serverless mode and should send a `debug` level log.
  // Else, if running in loop mode (pollingDelay != 0), then it should send a `info` level log.
  logger[config.pollingDelay === 0 ? "debug" : "info"]({
    at: "AcrossMonitor#index",
    message: "AcrossMonitor started 🔭",
    config,
  });

  const baseSigner = getSigner();
  const l1Provider = getProvider(config.hubPoolChainId);
  const hubSigner = baseSigner.connect(l1Provider);
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);
  const hubPoolClient = new HubPoolClient(logger, hubPool);
  const spokeSigners = config.spokePoolChainIds
    .map((networkId) => getProvider(networkId))
    .map((provider) => baseSigner.connect(provider));
  const spokePools = config.spokePoolChainIds.reduce((acc, chainId, idx) => {
    return {
      ...acc,
      [chainId]: getDeployedContract("SpokePool", chainId, spokeSigners[idx]) as SpokePool,
    };
  }, {} as Record<number, SpokePool>);

  const acrossMonitor = new AcrossMonitor(logger, config, hubPoolClient, spokePools);

  for (;;) {
    await retry(
      async () => {
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
      },
      {
        retries: config.errorRetries,
        minTimeout: config.errorRetriesTimeout * 1000, // delay between retries in ms
        randomize: false,
        onRetry: (error) => {
          logger.debug({
            at: "AcrossMonitor#index",
            message: "An error was thrown in the execution loop - retrying",
            error: typeof error === "string" ? new Error(error) : error,
          });
        },
      }
    );

    // If the bot runs serverless then the script will terminate the bot after one full run.
    if (config.pollingDelay === 0) {
      logger.debug({
        at: "AcrossMonitor#index",
        message: "End of serverless execution loop - terminating process",
      });
      await delay(5); // Set a delay to let the transports flush fully.
      break;
    }
    logger.debug({
      at: "AcrossMonitor#index",
      message: "End of execution loop - waiting polling delay",
      pollingDelay: `${config.pollingDelay} (s)`,
    });
    await delay(Number(config.pollingDelay));
  }
}
