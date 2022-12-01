import { Wallet, config, startupLogLevel, processEndPollingLoop, Contract, ethers } from "../utils";
import { winston } from "../utils";
import {
  finalizeArbitrum,
  getFinalizableMessages,
  getFinalizableTransactions,
  getPosClient,
  getOptimismClient,
  getOptimismFinalizableMessages,
  multicallOptimismFinalizations,
  multicallPolygonFinalizations,
  multicallPolygonRetrievals,
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
  FINALIZER_TOKENBRIDGE_LOOKBACK,
} from "../common";
import { Multicall2Ethers__factory } from "@uma/contracts-node";
config();
let logger: winston.Logger;

export interface Multicall2Call {
  callData: ethers.utils.BytesLike;
  target: string;
}

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
  // Note: Could move this into a client in the future to manage # of calls and chunk calls based on
  // input byte length.
  const multicall2 = new Contract(
    "0x5ba1e12693dc8f9c48aad8770482f4739beed696",
    Multicall2Ethers__factory.abi,
    hubPoolClient.hubPool.signer
  );

  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];
    const tokensBridged = client.getTokensBridged();

    if (chainId === 42161) {
      // Skip events that are likely not past the seven day challenge period.
      const olderTokensBridgedEvents = tokensBridged.filter(
        (e) => e.blockNumber < client.latestBlockNumber - optimisticRollupFinalizationWindow
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
      await multicallPolygonFinalizations(recentTokensBridgedEvents, posClient, multicall2, hubPoolClient, logger);
      await multicallPolygonRetrievals(recentTokensBridgedEvents, hubSigner, hubPoolClient, multicall2, logger);
    } else if (chainId === 10) {
      // Skip events that are likely not past the seven day challenge period.
      const olderTokensBridgedEvents = tokensBridged.filter(
        (e) => e.blockNumber < client.latestBlockNumber - optimisticRollupFinalizationWindow
      );
      const crossChainMessenger = getOptimismClient(hubSigner);
      await multicallOptimismFinalizations(
        olderTokensBridgedEvents,
        crossChainMessenger,
        multicall2,
        hubPoolClient,
        logger
      );
    }
  }
}

export async function constructFinalizerClients(_logger: winston.Logger, config, baseSigner: Wallet) {
  const commonClients = await constructClients(_logger, config, baseSigner);

  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.configStoreClient,
    config,
    baseSigner,
    config.maxFinalizerLookback
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
  readonly maxFinalizerLookback: number;

  constructor(env: ProcessEnv) {
    const {
      FINALIZER_OROLLUP_FINALIZATION_WINDOW,
      FINALIZER_POLYGON_FINALIZATION_WINDOW,
      FINALIZER_MAX_TOKENBRIDGE_LOOKBACK,
    } = env;
    super(env);

    // By default, filters out any TokensBridged events younger than 5 days old and older than 10 days old.
    this.optimisticRollupFinalizationWindow = FINALIZER_OROLLUP_FINALIZATION_WINDOW
      ? Number(FINALIZER_OROLLUP_FINALIZATION_WINDOW)
      : fiveDaysOfBlocks;
    // By default, filters out any TokensBridged events younger than 1 days old and older than 2 days old.
    this.polygonFinalizationWindow = FINALIZER_POLYGON_FINALIZATION_WINDOW
      ? Number(FINALIZER_POLYGON_FINALIZATION_WINDOW)
      : oneDayOfBlocks;
    // `maxFinalizerLookback` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxFinalizerLookback = FINALIZER_MAX_TOKENBRIDGE_LOOKBACK
      ? JSON.parse(FINALIZER_MAX_TOKENBRIDGE_LOOKBACK)
      : FINALIZER_TOKENBRIDGE_LOOKBACK;
  }
}

export async function runFinalizer(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;
  // Same config as Dataworker for now.
  const config = new FinalizerConfig(process.env);

  const { commonClients, spokePoolClients } = await constructFinalizerClients(logger, config, baseSigner);

  try {
    logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer started 🏋🏿‍♀️", config });

    for (;;) {
      const loopStart = Date.now();
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

      logger.debug({ at: "Finalizer#index", message: `Time to loop: ${(Date.now() - loopStart) / 1000}s` });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    if (commonClients.configStoreClient.redisClient !== undefined) {
      // If this throws an exception, it will mask the underlying error.
      logger.debug("Disconnecting from redis server.");
      commonClients.configStoreClient.redisClient.disconnect();
    }
    throw error;
  }
}
