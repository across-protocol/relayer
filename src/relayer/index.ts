import { utils as sdkUtils } from "@across-protocol/sdk";
import {
  config,
  delay,
  disconnectRedisClients,
  getCurrentTime,
  getNetworkName,
  getRedisCache,
  Signer,
  winston,
} from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients } from "./RelayerClientHelper";
config();
let logger: winston.Logger;

const ACTIVE_RELAYER_EXPIRY = 600; // 10 minutes.
const { RUN_IDENTIFIER: runIdentifier, BOT_IDENTIFIER: botIdentifier } = process.env;
const randomNumber = () => Math.floor(Math.random() * 1_000_000);

export async function runRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const relayerRun = randomNumber();
  const startTime = getCurrentTime();

  logger = _logger;
  const config = new RelayerConfig(process.env);
  const { externalIndexer, pollingDelay, sendingRelaysEnabled, sendingSlowRelaysEnabled } = config;

  const loop = pollingDelay > 0;
  let stop = !loop;
  process.on("SIGHUP", () => {
    logger.debug({
      at: "Relayer#run",
      message: "Received SIGHUP, stopping at end of current loop.",
    });
    stop = true;
  });

  const redis = await getRedisCache(logger);
  let activeRelayerUpdated = false;

  // Explicitly don't log ignoredAddresses because it can be huge and can overwhelm log transports.
  const { ignoredAddresses: _ignoredConfig, ...loggedConfig } = config;
  logger.debug({ at: "Relayer#run", message: "Relayer started 🏃‍♂️", loggedConfig, relayerRun });
  const relayerClients = await constructRelayerClients(logger, config, baseSigner);
  const relayer = new Relayer(await baseSigner.getAddress(), logger, relayerClients, config);
  const simulate = !sendingRelaysEnabled;

  const { spokePoolClients } = relayerClients;
  let txnReceipts: { [chainId: number]: Promise<string[]> };

  try {
    for (let run = 1; !stop; ++run) {
      if (loop) {
        logger.debug({ at: "relayer#run", message: `Starting relayer execution loop ${run}.` });
      }

      const tLoopStart = performance.now();
      const ready = await relayer.update();
      const activeRelayer = await redis.get(botIdentifier);

      // If there is another active relayer, allow up to 10 update cycles for this instance to be ready,
      // then proceed unconditionally to protect against any RPC outages blocking the relayer.
      if (!ready && activeRelayer && run < 10) {
        const runTime = Math.round((performance.now() - tLoopStart) / 1000);
        const delta = pollingDelay - runTime;
        logger.debug({ at: "Relayer#run", message: `Not ready to relay, waiting ${delta} seconds.` });
        await delay(delta);
        continue;
      }

      // Signal to any existing relayer that a handover is underway, or alternatively
      // check for handover initiated by another (newer) relayer instance.
      if (loop && botIdentifier && runIdentifier) {
        if (activeRelayer !== runIdentifier) {
          if (!activeRelayerUpdated) {
            await redis.set(botIdentifier, runIdentifier, ACTIVE_RELAYER_EXPIRY);
            activeRelayerUpdated = true;
          } else {
            logger.debug({ at: "Relayer#run", message: `Handing over to ${botIdentifier} instance ${activeRelayer}.` });
            stop = true;
          }
        }
      }

      if (!stop) {
        txnReceipts = await relayer.checkForUnfilledDepositsAndFill(sendingSlowRelaysEnabled, simulate);
        await relayer.runMaintenance();
      }

      if (loop) {
        const runTime = Math.round((performance.now() - tLoopStart) / 1000);
        logger.debug({
          at: "Relayer#run",
          message: `Completed relayer execution loop ${run} in ${runTime} seconds.`,
        });

        if (!stop && runTime < pollingDelay) {
          const delta = pollingDelay - runTime;
          logger.debug({
            at: "relayer#run",
            message: `Waiting ${delta} s before next loop.`,
          });
          await delay(delta);
        }
      }
    }

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

    if (externalIndexer) {
      Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.stopWorker());
    }
  }

  const runtime = getCurrentTime() - startTime;
  logger.debug({ at: "Relayer#index", message: `Completed relayer run ${relayerRun} in ${runtime} seconds.` });
}
