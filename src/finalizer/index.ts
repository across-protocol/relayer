import {
  Wallet,
  config,
  startupLogLevel,
  processEndPollingLoop,
  getNetworkName,
  etherscanLink,
  getBlockForTimestamp,
  getCurrentTime,
  disconnectRedisClient,
  getMultisender,
} from "../utils";
import { winston } from "../utils";
import {
  getPosClient,
  getOptimismClient,
  multicallOptimismFinalizations,
  multicallPolygonFinalizations,
  multicallArbitrumFinalizations,
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
  Multicall2Call,
} from "../common";
import * as optimismSDK from "@eth-optimism/sdk";
config();
let logger: winston.Logger;

export interface Withdrawal {
  l2ChainId: number;
  l1TokenSymbol: string;
  amount: string;
}

// Filter for optimistic rollups
const oneDaySeconds = 24 * 60 * 60;

export async function finalize(
  logger: winston.Logger,
  hubSigner: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  configuredChainIds: number[],
  optimisticRollupFinalizationWindow: number = 5 * oneDaySeconds,
  polygonFinalizationWindow: number = oneDaySeconds
): Promise<void> {
  // Note: Could move this into a client in the future to manage # of calls and chunk calls based on
  // input byte length.
  const multicall2 = getMultisender(1, hubSigner);
  const finalizationsToBatch: { callData: Multicall2Call[]; withdrawals: Withdrawal[] } = {
    callData: [],
    withdrawals: [],
  };
  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];
    if (client === undefined) {
      logger.warn({
        at: "Finalizer",
        message: `Skipping finalizations for ${getNetworkName(
          chainId
        )} because spoke pool client does not exist, is it disabled?`,
        configuredChainIds,
        availableChainIds: Object.keys(spokePoolClients),
      });
      continue;
    }
    const tokensBridged = client.getTokensBridged();

    if (chainId === 42161) {
      const firstBlockToFinalize = await getBlockForTimestamp(
        hubPoolClient.chainId,
        chainId,
        getCurrentTime() - optimisticRollupFinalizationWindow,
        getCurrentTime()
      );
      logger.debug({
        at: "Finalizer",
        message: `Oldest TokensBridged block to attempt to finalize for ${getNetworkName(chainId)}`,
        firstBlockToFinalize,
      });
      // Skip events that are likely not past the seven day challenge period.
      const olderTokensBridgedEvents = tokensBridged.filter((e) => e.blockNumber < firstBlockToFinalize);
      const finalizations = await multicallArbitrumFinalizations(
        olderTokensBridgedEvents,
        hubSigner,
        hubPoolClient,
        logger
      );
      finalizationsToBatch.callData.push(...finalizations.callData);
      finalizationsToBatch.withdrawals.push(...finalizations.withdrawals);
    } else if (chainId === 137) {
      const posClient = await getPosClient(hubSigner);
      const lastBlockToFinalize = await getBlockForTimestamp(
        hubPoolClient.chainId,
        chainId,
        getCurrentTime() - polygonFinalizationWindow,
        getCurrentTime()
      );
      logger.debug({
        at: "Finalizer",
        message: `Earliest TokensBridged block to attempt to finalize for ${getNetworkName(chainId)}`,
        lastBlockToFinalize,
      });
      // Unlike the rollups, withdrawals process very quickly on polygon, so we can conservatively remove any events
      // that are older than 1 day old:
      const recentTokensBridgedEvents = tokensBridged.filter((e) => e.blockNumber >= lastBlockToFinalize);
      const finalizations = await multicallPolygonFinalizations(
        recentTokensBridgedEvents,
        posClient,
        hubSigner,
        hubPoolClient,
        logger
      );
      finalizationsToBatch.callData.push(...finalizations.callData);
      finalizationsToBatch.withdrawals.push(...finalizations.withdrawals);
    } else if (chainId === 10) {
      // Skip events that are likely not past the seven day challenge period.
      const firstBlockToFinalize = await getBlockForTimestamp(
        hubPoolClient.chainId,
        chainId,
        getCurrentTime() - optimisticRollupFinalizationWindow,
        getCurrentTime()
      );
      logger.debug({
        at: "Finalizer",
        message: `Oldest TokensBridged block to attempt to finalize for ${getNetworkName(chainId)}`,
        firstBlockToFinalize,
      });
      const olderTokensBridgedEvents = tokensBridged.filter((e) => e.blockNumber < firstBlockToFinalize);
      const crossChainMessenger = getOptimismClient(chainId, hubSigner) as optimismSDK.CrossChainMessenger;
      const finalizations = await multicallOptimismFinalizations(
        chainId,
        olderTokensBridgedEvents,
        crossChainMessenger,
        hubPoolClient,
        logger
      );
      finalizationsToBatch.callData.push(...finalizations.callData);
      finalizationsToBatch.withdrawals.push(...finalizations.withdrawals);
    } else if (chainId === 288) {
      throw new Error(`ChainId ${chainId} is not supported`);
    }
  }

  if (finalizationsToBatch.callData.length > 0) {
    try {
      // Note: We might want to slice these up in the future but I don't forsee us including enough events
      // to approach the block gas limit.
      const txn = await (await multicall2.aggregate(finalizationsToBatch.callData)).wait();
      finalizationsToBatch.withdrawals.forEach((withdrawal) => {
        logger.info({
          at: "Finalizer",
          message: `Finalized ${getNetworkName(withdrawal.l2ChainId)} withdrawal for ${withdrawal.amount} of ${
            withdrawal.l1TokenSymbol
          } 🪃`,
          transactionHash: etherscanLink(txn.transactionHash, 1),
        });
      });
    } catch (_error) {
      const error = _error as Error;
      logger.warn({
        at: "Finalizer",
        message: "Error creating aggregateTx",
        reason: error.stack || error.message || error.toString(),
        notificationPath: "across-error",
      });
    }
  }
}

export async function constructFinalizerClients(
  _logger: winston.Logger,
  config: FinalizerConfig,
  baseSigner: Wallet
): Promise<{
  commonClients: Clients;
  spokePoolClients: SpokePoolClientsByChain;
}> {
  const commonClients = await constructClients(_logger, config, baseSigner);
  await updateFinalizerClients(commonClients);

  // Construct spoke pool clients for all chains that are not *currently* disabled. Caller can override
  // the disabled chain list by setting the DISABLED_CHAINS_OVERRIDE environment variable.
  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.hubPoolClient,
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
  await clients.configStoreClient.update();
  await clients.hubPoolClient.update();
}

export class FinalizerConfig extends DataworkerConfig {
  readonly maxFinalizerLookback: number;

  constructor(env: ProcessEnv) {
    const { FINALIZER_MAX_TOKENBRIDGE_LOOKBACK } = env;
    super(env);

    // `maxFinalizerLookback` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxFinalizerLookback = Number(FINALIZER_MAX_TOKENBRIDGE_LOOKBACK ?? FINALIZER_TOKENBRIDGE_LOOKBACK);
  }
}

export async function runFinalizer(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;
  // Same config as Dataworker for now.
  const config = new FinalizerConfig(process.env);

  logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer started 🏋🏿‍♀️", config });
  const { commonClients, spokePoolClients } = await constructFinalizerClients(logger, config, baseSigner);

  try {
    for (;;) {
      const loopStart = Date.now();
      await updateSpokePoolClients(spokePoolClients, ["TokensBridged", "EnabledDepositRoute"]);

      if (config.finalizerEnabled) {
        await finalize(
          logger,
          commonClients.hubSigner,
          commonClients.hubPoolClient,
          spokePoolClients,
          config.finalizerChains
        );
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Finalizer disabled" });
      }

      logger.debug({ at: "Finalizer#index", message: `Time to loop: ${(Date.now() - loopStart) / 1000}s` });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) {
        break;
      }
    }
  } catch (error) {
    await disconnectRedisClient(logger);
    throw error;
  }
}
