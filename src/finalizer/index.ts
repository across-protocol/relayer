import assert from "assert";
import { groupBy } from "lodash";
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
  winston,
} from "../utils";
import {
  getPosClient,
  getOptimismClient,
  multicallOptimismFinalizations,
  multicallPolygonFinalizations,
  multicallArbitrumFinalizations,
  multicallOptimismL1Proofs,
} from "./utils";
import { SpokePoolClientsByChain } from "../interfaces";
import { HubPoolClient, SpokePoolClient } from "../clients";
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
import { ChainFinalizer, FinalizerPromise, Withdrawal } from "./types";

config();
let logger: winston.Logger;

// Filter for optimistic rollups
const oneDaySeconds = 24 * 60 * 60;

async function optimismFinalizer(
  logger: winston.Logger,
  signer: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;
  assert(chainId === 10, `Chain ID mismatch: ${chainId} != 10`);

  const crossChainMessenger = getOptimismClient(10, signer);

  // Sort tokensBridged events by their age. Submit proofs for recent events, and withdrawals for older events.
  const earliestBlockToProve = latestBlockToFinalize + 1;
  const { recentTokensBridgedEvents = [], olderTokensBridgedEvents = [] } = groupBy(
    spokePoolClient.getTokensBridged(),
    (e) => (e.blockNumber >= earliestBlockToProve ? "recentTokensBridgedEvents" : "olderTokensBridgedEvents")
  );

  // First submit proofs for any newly withdrawn tokens. You can submit proofs for any withdrawals that have been
  // snapshotted on L1, so it takes roughly 1 hour from the withdrawal time
  logger.debug({
    at: "Finalizer#optimismFinalizer",
    message: `Earliest TokensBridged block to attempt to submit proofs for ${getNetworkName(chainId)}`,
    earliestBlockToProve,
  });

  const proofs = await multicallOptimismL1Proofs(
    chainId,
    recentTokensBridgedEvents,
    crossChainMessenger,
    hubPoolClient,
    logger
  );

  // Next finalize withdrawals that have passed challenge period.
  // Skip events that are likely not past the seven day challenge period.
  logger.debug({
    at: "Finalizer",
    message: `Oldest TokensBridged block to attempt to finalize for ${getNetworkName(chainId)}`,
    latestBlockToFinalize,
  });

  const finalizations = await multicallOptimismFinalizations(
    chainId,
    olderTokensBridgedEvents,
    crossChainMessenger,
    hubPoolClient,
    logger
  );

  const callData = [...proofs.callData, ...finalizations.callData];
  const withdrawals = [...proofs.withdrawals, ...finalizations.withdrawals];

  return { callData, withdrawals };
}

async function polygonFinalizer(
  logger: winston.Logger,
  signer: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;

  const posClient = await getPosClient(signer);
  logger.debug({
    at: "Finalizer#polygonFinalizer",
    message: `Earliest TokensBridged block to attempt to finalize for ${getNetworkName(chainId)}`,
    latestBlockToFinalize,
  });

  // Unlike the rollups, withdrawals process very quickly on polygon, so we can conservatively remove any events
  // that are older than 1 day old:
  const recentTokensBridgedEvents = spokePoolClient
    .getTokensBridged()
    .filter((e) => e.blockNumber >= latestBlockToFinalize);

  return await multicallPolygonFinalizations(recentTokensBridgedEvents, posClient, signer, hubPoolClient, logger);
}

async function arbitrumOneFinalizer(
  logger: winston.Logger,
  signer: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;

  logger.debug({
    at: "Finalizer#arbitrumOneFinalizer",
    message: `Oldest TokensBridged block to attempt to finalize for ${getNetworkName(chainId)}`,
    latestBlockToFinalize,
  });
  // Skip events that are likely not past the seven day challenge period.
  const olderTokensBridgedEvents = spokePoolClient
    .getTokensBridged()
    .filter((e) => e.blockNumber < latestBlockToFinalize);

  return await multicallArbitrumFinalizations(olderTokensBridgedEvents, signer, hubPoolClient, logger);
}

const chainFinalizers: { [chainId: number]: ChainFinalizer } = {
  10: optimismFinalizer,
  137: polygonFinalizer,
  42161: arbitrumOneFinalizer,
};

export async function finalize(
  logger: winston.Logger,
  hubSigner: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  configuredChainIds: number[],
  optimisticRollupFinalizationWindow: number = 5 * oneDaySeconds,
  polygonFinalizationWindow: number = oneDaySeconds
): Promise<void> {
  const finalizationWindows: { [chainId: number]: number } = {
    10: optimisticRollupFinalizationWindow,
    137: polygonFinalizationWindow,
    42161: optimisticRollupFinalizationWindow,
  };

  const hubChainId = hubPoolClient.chainId;
  const hubChain = getNetworkName(hubChainId);

  // Note: Could move this into a client in the future to manage # of calls and chunk calls based on
  // input byte length.
  const multicall2 = getMultisender(hubChainId, hubSigner);
  const finalizationsToBatch: {
    callData: Multicall2Call[];
    withdrawals: Withdrawal[];
  } = {
    callData: [],
    withdrawals: [],
  };

  // For each chain, delegate to a handler to look up any TokensBridged events and attempt finalization.
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

    const chainFinalizer = chainFinalizers[chainId];
    assert(chainFinalizer !== undefined, `No withdrawal finalizer available for chain ${chainId}`);

    const finalizationWindow = finalizationWindows[chainId];
    assert(finalizationWindow !== undefined, `No finalization window defined for chain ${chainId}`);

    const latestBlockToFinalize = await getBlockForTimestamp(chainId, getCurrentTime() - finalizationWindow);

    const network = getNetworkName(chainId);
    logger.debug({ at: "finalize", message: `Spawning ${network} finalizer.`, latestBlockToFinalize });
    const { callData, withdrawals } = await chainFinalizer(
      logger,
      hubSigner,
      hubPoolClient,
      client,
      latestBlockToFinalize
    );
    logger.info({ at: "finalize", message: `Found ${callData.length} ${network} withdrawals for finalization.` });

    finalizationsToBatch.callData.push(...callData);
    finalizationsToBatch.withdrawals.push(...withdrawals);
  }

  if (finalizationsToBatch.callData.length > 0) {
    try {
      // Note: We might want to slice these up in the future but I don't forsee us including enough events
      // to approach the block gas limit.
      const txn = await (await multicall2.aggregate(finalizationsToBatch.callData)).wait();
      const { withdrawals = [], proofs = [] } = groupBy(finalizationsToBatch.withdrawals, ({ type }) => {
        return type === "withdrawal" ? "withdrawals" : "proofs";
      });
      proofs.forEach(({ l2ChainId, amount, l1TokenSymbol: symbol }) => {
        const spokeChain = getNetworkName(l2ChainId);
        logger.info({
          at: "Finalizer",
          message: `Submitted proof on chain ${hubChain} to initiate ${spokeChain} withdrawal of ${amount} ${symbol} 🪃`,
          transactionHash: etherscanLink(txn.transactionHash, hubChainId),
        });
      });
      withdrawals.forEach(({ l2ChainId, amount, l1TokenSymbol: symbol }) => {
        const spokeChain = getNetworkName(l2ChainId);
        logger.info({
          at: "Finalizer",
          message: `Finalized ${spokeChain} withdrawal for ${amount} ${symbol} 🪃`,
          transactionHash: etherscanLink(txn.transactionHash, hubChainId),
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

// @dev The HubPoolClient is dependent on the state of the ConfigStoreClient,
//      so update the ConfigStoreClient first. @todo: Use common/ClientHelpter.ts.
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
          process.env.FINALIZER_CHAINS
            ? JSON.parse(process.env.FINALIZER_CHAINS)
            : commonClients.configStoreClient.getChainIdIndicesForBlock()
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
