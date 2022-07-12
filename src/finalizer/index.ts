import { Wallet, config, startupLogLevel, processEndPollingLoop, processCrash, getSigner } from "../utils";
import { winston } from "../utils";
import {
  finalizeArbitrum,
  finalizePolygon,
  getFinalizableMessages,
  getFinalizableTransactions,
  getL2TokensToFinalize,
  getPosClient,
  retrieveTokenFromMainnetTokenBridger,
  getOptimismClient,
  getOptimismFinalizableMessages,
  finalizeOptimismMessage,
} from "./utils";
import { SpokePoolClientsByChain } from "../interfaces";
import { HubPoolClient } from "../clients";
import { DataworkerConfig } from "../dataworker/DataworkerConfig";
import {
  constructClients,
  constructSpokePoolClientsWithLookback,
  updateSpokePoolClients,
  Clients,
  ProcessEnv,
} from "../common";
config();
let logger: winston.Logger;

// Filter for optimistic rollups
const fiveDaysOfBlocks = 5 * 24 * 60 * 60; // Assuming a slow 1s/block rate for Arbitrum and Optimism.
// Filter for polygon
const oneDayOfBlocks = (24 * 60 * 60) / 2; // Assuming 2s/block

export async function finalize(
  logger: winston.Logger,
  hubSigner: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  configuredChainIds: number[],
  optimisticRollupFinalizationWindow: number = fiveDaysOfBlocks,
  polygonFinalizationWindow: number = oneDayOfBlocks
): Promise<void> {
  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];
    const tokensBridged = client.getTokensBridged();

    if (chainId === 42161) {
      // Skip events that are definitely not past the seven day challenge period, and those that are really
      // old and have already been finalized.
      const olderTokensBridgedEvents = tokensBridged.filter(
        (e) =>
          e.blockNumber < client.latestBlockNumber - optimisticRollupFinalizationWindow &&
          e.blockNumber >= client.latestBlockNumber - 2 * optimisticRollupFinalizationWindow
      );
      const finalizableMessages = await getFinalizableMessages(logger, olderTokensBridgedEvents, hubSigner);
      for (const l2Message of finalizableMessages) {
        await finalizeArbitrum(logger, l2Message.message, l2Message.info, hubPoolClient);
      }
    } else if (chainId === 137) {
      const posClient = await getPosClient(hubSigner);
      // Unlike the rollups, withdrawals process very quickly on polygon, so we can conservatively remove any events
      // that are older than 1 day old:
      const recentTokensBridgedEvents = tokensBridged.filter(
        (e) => e.blockNumber >= client.latestBlockNumber - polygonFinalizationWindow
      );
      const canWithdraw = await getFinalizableTransactions(logger, recentTokensBridgedEvents, posClient);
      for (const event of canWithdraw) {
        await finalizePolygon(posClient, hubPoolClient, event, logger);
      }
      for (const l2Token of getL2TokensToFinalize(recentTokensBridgedEvents)) {
        await retrieveTokenFromMainnetTokenBridger(logger, l2Token, hubSigner, hubPoolClient);
      }
    } else if (chainId === 10) {
      // Skip events that are definitely not past the seven day challenge period, and those that are really
      // old and have already been finalized.
      const olderTokensBridgedEvents = tokensBridged.filter(
        (e) =>
          e.blockNumber < client.latestBlockNumber - optimisticRollupFinalizationWindow &&
          e.blockNumber >= client.latestBlockNumber - 2 * optimisticRollupFinalizationWindow
      );
      const crossChainMessenger = getOptimismClient(hubSigner);
      const finalizableMessages = await getOptimismFinalizableMessages(
        logger,
        olderTokensBridgedEvents,
        crossChainMessenger
      );
      for (const message of finalizableMessages) {
        await finalizeOptimismMessage(hubPoolClient, crossChainMessenger, message, logger);
      }
    }
  }
}

export async function constructFinalizerClients(_logger: winston.Logger, config) {
  const baseSigner = await getSigner();

  const commonClients = await constructClients(_logger, config);

  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.configStoreClient,
    config,
    baseSigner,
    {} // We don't override the lookback as we want to look up all TokensBridged events.
  );

  return {
    commonClients,
    spokePoolClients,
  };
}

async function updateFinalizerClients(clients: Clients) {
  await Promise.all([clients.hubPoolClient.update(), clients.configStoreClient.update()]);
}

export class FinalizerConfig extends DataworkerConfig {
  readonly optimisticRollupFinalizationWindow: number;
  readonly polygonFinalizationWindow: number;

  constructor(env: ProcessEnv) {
    const { FINALIZER_OROLLUP_FINALIZATION_WINDOW, FINALIZER_POLYGON_FINALIZATION_WINDOW } = env;
    super(env);

    // By default, filters out any TokensBridged events younger than 5 days old and older than 10 days old.
    this.optimisticRollupFinalizationWindow = FINALIZER_OROLLUP_FINALIZATION_WINDOW
      ? Number(FINALIZER_OROLLUP_FINALIZATION_WINDOW)
      : fiveDaysOfBlocks;
    // By default, filters out any TokensBridged events younger than 1 days old and older than 2 days old.
    this.polygonFinalizationWindow = FINALIZER_POLYGON_FINALIZATION_WINDOW
      ? Number(FINALIZER_POLYGON_FINALIZATION_WINDOW)
      : oneDayOfBlocks;
  }
}

export async function runFinalizer(_logger: winston.Logger): Promise<void> {
  logger = _logger;
  // Same config as Dataworker for now.
  const config = new FinalizerConfig(process.env);

  const { commonClients, spokePoolClients } = await constructFinalizerClients(logger, config);

  try {
    logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer started 🏋🏿‍♀️", config });

    for (;;) {
      await updateFinalizerClients(commonClients);
      await updateSpokePoolClients(spokePoolClients, ["TokensBridged", "EnabledDepositRoute"]);

      if (config.finalizerEnabled)
        await finalize(
          logger,
          commonClients.hubSigner,
          commonClients.hubPoolClient,
          spokePoolClients,
          config.finalizerChains,
          config.optimisticRollupFinalizationWindow,
          config.polygonFinalizationWindow
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Finalizer disabled" });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    // eslint-disable-next-line no-process-exit
    if (await processCrash(logger, "Dataworker", config.pollingDelay, error)) process.exit(1);
    await runFinalizer(logger);
  }
}
