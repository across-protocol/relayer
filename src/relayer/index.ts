import { utils as sdkUtils } from "@across-protocol/sdk";
import {
  config,
  delay,
  disconnectRedisClients,
  getNetworkName,
  getRedisCache,
  isDefined,
  Profiler,
  Signer,
  winston,
} from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients } from "./RelayerClientHelper";
import { InventoryClientState } from "../clients";
import { updateSpokePoolClients } from "../common";
import { RedisCacheInterface } from "../caching/RedisCache";
config();
let logger: winston.Logger;

const ACTIVE_RELAYER_EXPIRY = 600; // 10 minutes.
const {
  RUN_IDENTIFIER: runIdentifier,
  BOT_IDENTIFIER: botIdentifier = "across-relayer",
  RELAYER_MAX_STARTUP_DELAY = "120",
} = process.env;

const maxStartupDelay = Number(RELAYER_MAX_STARTUP_DELAY);

export async function runRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const profiler = new Profiler({
    at: "Relayer#run",
    logger: _logger,
  });

  logger = _logger;
  const config = new RelayerConfig(process.env);
  const { externalListener, pollingDelay } = config;

  const loop = pollingDelay > 0;
  let stop = false;
  process.on("SIGHUP", () => {
    logger.debug({
      at: "Relayer#run",
      message: "Received SIGHUP, stopping at end of current loop.",
    });
    stop = true;
  });

  const redis = await getRedisCache(logger);
  let activeRelayerUpdated = false;

  // Explicitly don't log addressFilter because it can be huge and can overwhelm log transports.
  const { addressFilter: _addressFilter, ...loggedConfig } = config;
  logger.debug({ at: "Relayer#run", message: "Relayer started 🏃‍♂️", loggedConfig });
  const mark = profiler.start("relayer");
  const relayerClients = await constructRelayerClients(logger, config, baseSigner);
  const relayer = new Relayer(await baseSigner.getAddress(), logger, relayerClients, config);
  await relayer.init();

  const { spokePoolClients, inventoryClient } = relayerClients;
  const simulate = !config.sendingTransactionsEnabled || !config.sendingRelaysEnabled;
  let txnReceipts: { [chainId: number]: Promise<string[]> } = {};
  const inventoryManagement = inventoryClient.isInventoryManagementEnabled();
  let inventoryInit = false;

  try {
    for (let run = 1; !stop; ++run) {
      if (loop) {
        logger.debug({ at: "relayer#run", message: `Starting relayer execution loop ${run}.` });
      }
      const tLoopStart = profiler.start("Relayer execution loop");
      const ready = await relayer.update();
      const activeRelayer = redis ? await redis.get(botIdentifier) : undefined;

      // If there is another active relayer, allow up to maxStartupDelay seconds for this instance to be ready.
      // If one or more chains are still not updated by this point, proceed anyway.
      if (!ready && activeRelayer && !activeRelayerUpdated) {
        if (run * pollingDelay < maxStartupDelay) {
          const runTime = Math.round((performance.now() - tLoopStart.startTime) / 1000);
          const delta = pollingDelay - runTime;
          logger.debug({ at: "Relayer#run", message: `Not ready to relay, waiting ${delta} seconds.` });
          await delay(delta);
          continue;
        }

        const degraded = Object.values(spokePoolClients)
          .filter(({ isUpdated }) => !isUpdated)
          .map(({ chainId }) => getNetworkName(chainId));
        logger.warn({ at: "Relayer#run", message: "Assuming active relayer role in degraded state", degraded });
      }

      if (!inventoryInit && config.relayerUseInventoryManager) {
        const key = inventoryClient.getInventoryCacheKey(config.inventoryTopic);
        const inventoryState = await getInventoryState(redis, key);
        if (inventoryState) {
          inventoryClient.import(inventoryState);
          inventoryInit = true;
        } else {
          logger.error({ at: "Relayer#run", message: "No inventory state found in cache", key });
        }
      }

      // One time initialization of functions that handle lots of events only after all spokePoolClients are updated.
      if (!inventoryInit && inventoryManagement) {
        inventoryClient.setBundleData();
        await inventoryClient.update(relayer.inventoryChainIds);
        inventoryInit = true;
      }

      // Signal to any existing relayer that a handover is underway, or alternatively
      // check for handover initiated by another (newer) relayer instance.
      if (loop && runIdentifier && redis) {
        if (activeRelayer !== runIdentifier) {
          if (!activeRelayerUpdated) {
            logger.debug({
              at: "Relayer#run",
              message: `Taking over from ${botIdentifier} instance ${activeRelayer}.`,
            });
            await redis.set(botIdentifier, runIdentifier, ACTIVE_RELAYER_EXPIRY);
            activeRelayerUpdated = true;
          } else {
            logger.debug({ at: "Relayer#run", message: `Handing over to ${botIdentifier} instance ${activeRelayer}.` });
            stop = true;
          }
        }
      }

      if (!stop) {
        txnReceipts = await relayer.checkForUnfilledDepositsAndFill(config.sendingSlowRelaysEnabled, simulate);
        await relayer.runMaintenance();
      }

      if (!loop) {
        stop = true;
      } else {
        const runTimeMilliseconds = tLoopStart.stop({
          message: "Completed relayer execution loop.",
          loopCount: run,
        });
        if (!stop) {
          const runTime = Math.round(runTimeMilliseconds / 1000);

          // When txns are pending submission, yield execution to ensure they can be submitted.
          const minDelay = Object.values(txnReceipts).length > 0 ? 0.1 : 0;
          const delta = pollingDelay > runTime ? pollingDelay - runTime : minDelay;
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

    if (externalListener) {
      Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.stopWorker());
    }
  }

  mark.stop({ message: "Relayer instance completed." });
}

export async function runRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const personality = "Rebalancer";
  const at = `${personality}::run`;

  logger = _logger;
  const config = new RelayerConfig(process.env);

  // Explicitly don't log addressFilter because it can be huge and can overwhelm log transports.
  const { addressFilter: _addressFilter, ...loggedConfig } = config;
  logger.debug({ at, message: `${personality} started 🏃‍♂️`, loggedConfig });
  const clients = await constructRelayerClients(logger, config, baseSigner);

  const { inventoryClient } = clients;
  const inventoryManagement = clients.inventoryClient.isInventoryManagementEnabled();
  if (!inventoryManagement) {
    logger.debug({ at, message: "Inventory management disabled, nothing to do." });
    return;
  }
  inventoryClient.setBundleData();

  const rebalancer = new Relayer(await baseSigner.getAddress(), logger, clients, config);

  try {
    await rebalancer.init();
    await rebalancer.update();
    await inventoryClient.update(rebalancer.inventoryChainIds);
    await rebalancer.checkForUnfilledDepositsAndFill(false, true);

    if (config.sendingTransactionsEnabled) {
      await inventoryClient.setTokenApprovals();
    }

    await inventoryClient.rebalanceInventoryIfNeeded();
    // Need to update here to capture all pending L1 to L2 rebalances sent from above function.
    await inventoryClient.withdrawExcessBalances();
  } finally {
    await disconnectRedisClients(logger);
    logger.debug({ at, message: `${personality} instance completed.` });
  }
}

export async function runInventoryManager(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const personality = "InventoryManager";
  const at = `${personality}::run`;
  const config = new RelayerConfig(process.env);
  logger = _logger;

  try {
    const redis = await getRedisCache(logger);

    const clients = await constructRelayerClients(logger, config, baseSigner);
    const { spokePoolClients, inventoryClient } = clients;

    await updateSpokePoolClients(spokePoolClients, [
      "FundsDeposited",
      "FilledRelay",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ]);

    inventoryClient.setBundleData();
    await inventoryClient.update(config.spokePoolChainsOverride);

    const inventory = inventoryClient.export();
    await setInventoryState(redis, inventoryClient.getInventoryCacheKey(config.inventoryTopic), inventory);
  } finally {
    await disconnectRedisClients(logger);
    logger.debug({ at, message: `${personality} instance completed.` });
  }
}

async function setInventoryState(
  redis: RedisCacheInterface,
  topic: string,
  state: InventoryClientState,
  ttl = 900 // 15 minutes
): Promise<void> {
  const value = JSON.stringify(state, sdkUtils.jsonReplacerWithBigNumbers);
  await redis.set(topic, value, ttl);
}

async function getInventoryState(redis: RedisCacheInterface, topic: string): Promise<InventoryClientState | undefined> {
  const state = await redis.get<string>(topic);
  if (!isDefined(state)) {
    return undefined;
  }

  const processedState = JSON.parse(state, sdkUtils.jsonReviverWithBigNumbers);
  return processedState;
}
