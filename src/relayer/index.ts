import { utils as sdkUtils } from "@across-protocol/sdk";
import { config, delay, disconnectRedisClients, getCurrentTime, getNetworkName, Signer, winston } from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients, updateRelayerClients } from "./RelayerClientHelper";
config();
let logger: winston.Logger;

const { RUN_IDENTIFIER: runIdentifier, BOT_IDENTIFIER: botIdentifier } = process.env;
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

  const redis = await getRedisCache(logger);
  let setActiveRelayer = false;

  // Explicitly don't log ignoredAddresses because it can be huge and can overwhelm log transports.
  const { ignoredAddresses: _ignoredConfig, ...loggedConfig } = config;
  logger.debug({ at: "Relayer#run", message: "Relayer started 🏃‍♂️", loggedConfig, relayerRun });
  const relayerClients = await constructRelayerClients(logger, config, baseSigner);
  const relayer = new Relayer(await baseSigner.getAddress(), logger, relayerClients, config);

  let run = 1;
  let txnReceipts: { [chainId: number]: Promise<string[]> };
  try {
    do {
      if (loop) {
        logger.debug({ at: "relayer#run", message: `Starting relayer execution loop ${run}.` });
      }

      const tLoopStart = performance.now();
      if (run !== 1) {
        await relayerClients.configStoreClient.update();
        await relayerClients.hubPoolClient.update();
      }
      await updateRelayerClients(relayerClients, config);

      if (!config.skipRelays) {
        // Since the above spoke pool updates are slow, refresh token client before sending rebalances now:
        relayerClients.tokenClient.clearTokenData();
        await relayerClients.tokenClient.update();
        const simulate = !config.sendingRelaysEnabled;
        txnReceipts = await relayer.checkForUnfilledDepositsAndFill(config.sendingSlowRelaysEnabled, simulate);
      }

      // Unwrap WETH after filling deposits so we don't mess up slow fill logic, but before rebalancing
      // any tokens so rebalancing can take into account unwrapped WETH balances.
      await relayerClients.inventoryClient.unwrapWeth();

      if (!config.skipRebalancing) {
        // Since the above spoke pool updates are slow, refresh token client before sending rebalances now:
        relayerClients.tokenClient.clearTokenData();
        await relayerClients.tokenClient.update();
        await relayerClients.inventoryClient.rebalanceInventoryIfNeeded();
      }

      // Clear state from profit and token clients. These are updated on every iteration and should start fresh.
      relayerClients.profitClient.clearUnprofitableFills();
      relayerClients.tokenClient.clearTokenShortfall();

      if (loop) {
        const runTime = Math.round((performance.now() - tLoopStart) / 1000);
        logger.debug({
          at: "Relayer#run",
          message: `Completed relayer execution loop ${run++} in ${runTime} seconds.`,
        });

        // Signal to any existing relayer that a handover is underway, or alternatively
        // check for a handover initiated by another (newer) relayer instance.
        if (botIdentifier && runIdentifier) {
          const activeRelayer = await redis.get(botIdentifier);
          if (activeRelayer !== runIdentifier) {
            if (!setActiveRelayer) {
              await redis.set(botIdentifier, runIdentifier);
              setActiveRelayer = true;
            } else {
              logger.debug({
                at: "Relayer#run",
                message: `Handing over to ${botIdentifier} instance ${activeRelayer}.`,
              });
              stop = true;
            }
          }
        }

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
