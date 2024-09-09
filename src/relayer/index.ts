import { utils as sdkUtils } from "@across-protocol/sdk";
import { updateSpokePoolClients } from "../common";
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

  const { acrossApiClient, inventoryClient, profitClient, spokePoolClients, tokenClient } = relayerClients;
  const inventoryChainIds =
    config.pollingDelay === 0 ? Object.values(spokePoolClients).map(({ chainId }) => chainId) : [];

  let txnReceipts: { [chainId: number]: Promise<string[]> };
  let run = 1;

  try {
    do {
      if (loop) {
        logger.debug({ at: "relayer#run", message: `Starting relayer execution loop ${run}.` });
      }

      const tLoopStart = performance.now();
      if (run !== 1) {
        await relayerClients.configStoreClient.update();
        await relayerClients.hubPoolClient.update();
        await tokenClient.update();
      }
      // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.
      // TODO: the code below can be refined by grouping with promise.all. however you need to consider the inter
      // dependencies of the clients. some clients need to be updated before others. when doing this refactor consider
      // having a "first run" update and then a "normal" update that considers this. see previous implementation here
      // https://github.com/across-protocol/relayer/pull/37/files#r883371256 as a reference.
      await updateSpokePoolClients(spokePoolClients, [
        "V3FundsDeposited",
        "RequestedSpeedUpV3Deposit",
        "FilledV3Relay",
        "RelayedRootBundle",
        "ExecutedRelayerRefundRoot",
      ]);

      // We can update the inventory client in parallel with checking for eth wrapping as these do not depend on each other.
      // Cross-chain deposit tracking produces duplicates in looping mode, so in that case don't attempt it. This does not
      // disable inventory management, but does make it ignorant of in-flight cross-chain transfers. The rebalancer is
      // assumed to run separately from the relayer and with pollingDelay 0, so it doesn't loop and will track transfers
      // correctly to avoid repeat rebalances.
      await Promise.all([
        acrossApiClient.update(config.ignoreLimits),
        inventoryClient.update(inventoryChainIds),
        inventoryClient.wrapL2EthIfAboveThreshold(),
      ]);

      // Since the above spoke pool updates are slow, refresh token client before sending rebalances now.
      tokenClient.clearTokenData();
      await tokenClient.update();

      txnReceipts = await relayer.checkForUnfilledDepositsAndFill(enableSlowFills, simulate);

      // Unwrap WETH after filling deposits so we don't mess up slow fill logic, but before rebalancing
      // any tokens so rebalancing can take into account unwrapped WETH balances.
      await inventoryClient.unwrapWeth();

      if (config.sendingRebalancesEnabled) {
        // Since the above spoke pool updates are slow, refresh token client before sending rebalances now:
        tokenClient.clearTokenData();
        await tokenClient.update();
        await inventoryClient.rebalanceInventoryIfNeeded();
      }

      // Clear state from profit and token clients. These are updated on every iteration and should start fresh.
      profitClient.clearUnprofitableFills();
      tokenClient.clearTokenShortfall();

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
      Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.stopWorker());
    }
  }

  const runtime = getCurrentTime() - startTime;
  logger.debug({ at: "Relayer#index", message: `Completed relayer run ${relayerRun} in ${runtime} seconds.` });
}
