import { utils as sdkUtils } from "@across-protocol/sdk";
import { config, delay, disconnectRedisClients, getCurrentTime, getNetworkName, Signer, winston } from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients } from "./RelayerClientHelper";
config();
let logger: winston.Logger;

const randomNumber = () => Math.floor(Math.random() * 1_000_000);

export async function runRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const relayerRun = randomNumber();
  const startTime = getCurrentTime();

  logger = _logger;
  const config = new RelayerConfig(process.env);

  const loop = config.pollingDelay > 0;
  let stop = !loop;
  process.on("SIGHUP", () => {
    logger.debug({
      at: "Relayer#run",
      message: "Received SIGHUP, stopping at end of current loop.",
    });
    stop = true;
  });

  // Explicitly don't log ignoredAddresses because it can be huge and can overwhelm log transports.
  const { ignoredAddresses: _ignoredConfig, ...loggedConfig } = config;
  logger.debug({ at: "Relayer#run", message: "Relayer started 🏃‍♂️", loggedConfig, relayerRun });
  const relayerClients = await constructRelayerClients(logger, config, baseSigner);
  const relayer = new Relayer(await baseSigner.getAddress(), logger, relayerClients, config);
  const simulate = !config.sendingRelaysEnabled;
  const enableSlowFills = config.sendingSlowRelaysEnabled;

  let txnReceipts: { [chainId: number]: Promise<string[]> };
  let run = 1;

  try {
    do {
      if (loop) {
        logger.debug({ at: "relayer#run", message: `Starting relayer execution loop ${run}.` });
      }

      const tLoopStart = performance.now();

      await relayer.update();
      txnReceipts = await relayer.checkForUnfilledDepositsAndFill(enableSlowFills, simulate);
      await relayer.manageInventory();

      if (loop) {
        const runTime = Math.round((performance.now() - tLoopStart) / 1000);
        logger.debug({
          at: "Relayer#run",
          message: `Completed relayer execution loop ${run++} in ${runTime} seconds.`,
        });

        if (!stop && runTime < config.pollingDelay) {
          const delta = config.pollingDelay - runTime;
          logger.debug({
            at: "relayer#run",
            message: `Waiting ${delta} s before next loop.`,
          });
          await delay(delta);
        }
      }
    } while (!stop);

    // Before exiting, wait for transaction submission to complete.
    for (const [chainId, submission] of Object.entries(txnReceipts)) {
      const [result] = await Promise.allSettled([submission]);
      if (sdkUtils.isPromiseRejected(result)) {
        logger.warn({
          at: "Relayer#runRelayer",
          message: `Failed transaction submission on ${getNetworkName(Number(chainId))}.`,
          reason: result.reason,
        });
      }
    }
  } finally {
    await disconnectRedisClients(logger);

    if (config.externalIndexer) {
      Object.values(relayerClients.spokePoolClients).map((spokePoolClient) => spokePoolClient.stopWorker());
    }
  }

  const runtime = getCurrentTime() - startTime;
  logger.debug({ at: "Relayer#index", message: `Completed relayer run ${relayerRun} in ${runtime} seconds.` });
}
