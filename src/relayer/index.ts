import assert from "assert";
import { utils as sdkUtils } from "@across-protocol/sdk";
import {
  config,
  delay,
  disconnectRedisClients,
  getNetworkName,
  getRedisCache,
  isDefined,
  Profiler,
  scheduleTask,
  Signer,
  winston,
} from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients } from "./RelayerClientHelper";
import { InventoryClientState, isSpokePoolClientWithListener } from "../clients";
import { updateSpokePoolClients } from "../common";
import { RedisCacheInterface } from "../caching/RedisCache";
import { RebalancerConfig } from "../rebalancer/RebalancerConfig";
config();
let logger: winston.Logger;

const ACTIVE_RELAYER_EXPIRY = 600; // 10 minutes.
const {
  RUN_IDENTIFIER: runIdentifier,
  BOT_IDENTIFIER: botIdentifier = "across-relayer",
  RELAYER_MAX_STARTUP_DELAY = "120",
} = process.env;

const maxStartupDelay = Number(RELAYER_MAX_STARTUP_DELAY);
const abortController = new AbortController();

const sighup = () => {
  process.on("SIGHUP", () => {
    logger.debug({
      at: "Relayer#run",
      message: "Received SIGHUP, stopping...",
    });
    abortController.abort();
  });
};

export async function runRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const at = "runRelayer";
  logger = _logger;
  sighup();

  const profiler = new Profiler({
    at: "Relayer#run",
    logger,
  });

  const config = new RelayerConfig(process.env);
  const { eventListener, externalListener, pollingDelay } = config;

  const loop = pollingDelay > 0;

  const redis = await getRedisCache(logger);
  let activeRelayerUpdated = false;

  // Explicitly don't log addressFilter because it can be huge and can overwhelm log transports.
  const { addressFilter: _addressFilter, ...loggedConfig } = config;
  logger.debug({ at, message: "Relayer started 🏃‍♂️", loggedConfig });
  const mark = profiler.start("relayer");
  const relayerClients = await constructRelayerClients(logger, config, baseSigner);
  const relayer = new Relayer(await baseSigner.getAddress(), logger, relayerClients, config);
  await relayer.init();

  const { acrossApiClient, inventoryClient, spokePoolClients, tokenClient } = relayerClients;
  const simulate = !config.sendingTransactionsEnabled || !config.sendingRelaysEnabled;
  let txnReceipts: { [chainId: number]: Promise<string[]> } = {};
  const inventoryManagement = inventoryClient.isInventoryManagementEnabled();
  let inventoryInit = false;

  const apiUpdateInterval = 30; // seconds
  scheduleTask(() => acrossApiClient.update(config.ignoreLimits), apiUpdateInterval, abortController.signal);

  if (eventListener) {
    const hubChainSpoke = spokePoolClients[config.hubPoolChainId];
    assert(isSpokePoolClientWithListener(hubChainSpoke));

    const updates: { [blockNumber: number]: boolean } = {};
    const updateHub = async (): Promise<void> => {
      const { configStoreClient, hubPoolClient } = relayerClients;
      await configStoreClient.update();
      await Promise.all([hubPoolClient.update(), tokenClient.update()]);
    };

    const newBlock = (blockNumber: number, currentTime: number) => {
      // Protect against duplicate events by tracking blockNumbers previously updated.
      const updated = updates[blockNumber];
      if (updated) {
        logger.debug({ at, message: "Received duplicate Hub Chain block update.", blockNumber, currentTime });
        return;
      }

      updates[blockNumber] = true;
      logger.debug({ at, message: "Received new Hub Chain block update.", blockNumber, currentTime });
      setTimeout(async () => updateHub());
    };
    hubChainSpoke.onBlock(newBlock);
  }

  try {
    for (let run = 1; !abortController.signal.aborted; ++run) {
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
        logger.debug({ at: "Relayer#run", message: "Checking for inventory state in cache" });
        const key = inventoryClient.getInventoryCacheKey(config.inventoryTopic);
        const inventoryState = await getInventoryState(redis, key);
        if (inventoryState) {
          inventoryClient.import(inventoryState);
          inventoryInit = true;
          logger.debug({ at: "Relayer#run", message: "Inventory state found in cache", state: inventoryState });
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
            abortController.abort();
          }
        }
      }

      if (!abortController.signal.aborted) {
        txnReceipts = await relayer.checkForUnfilledDepositsAndFill(config.sendingSlowRelaysEnabled, simulate);
        await relayer.runMaintenance();
      }

      if (!loop) {
        abortController.abort();
      } else {
        const runTimeMilliseconds = tLoopStart.stop({
          message: "Completed relayer execution loop.",
          loopCount: run,
        });
        if (!abortController.signal.aborted) {
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
  sighup();

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
    abortController.abort();
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
  return processedState.inventoryConfig && processedState.bundleDataState && processedState.pendingL2Withdrawals
    ? processedState
    : undefined;
}
