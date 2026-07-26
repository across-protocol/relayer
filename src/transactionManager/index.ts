import assert from "assert";
import { config, getProvider, Signer, startupLogLevel, winston } from "../utils";
import { getRedisCache } from "../cache/Redis";
import { getRedisPubSub } from "../messaging/redis/PubSub";
import { TransactionManager } from "./TransactionManager";
import { TransactionManagerConfig } from "./TransactionManagerConfig";

config();

export { TransactionManager, TransactionManagerConfig };

export async function runTransactionManager(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const logger = _logger;
  const eoa = await baseSigner.getAddress();
  const cfg = new TransactionManagerConfig(process.env, eoa);

  const provider = await getProvider(cfg.chainId, logger);
  const signer = baseSigner.connect(provider);

  const cache = await getRedisCache(logger);
  assert(cache !== undefined, "TransactionManager requires a Redis cache for lease coordination");
  // Redis forbids PUBLISH on a SUBSCRIBE'd connection, so we need distinct sockets.
  const publisher = await getRedisPubSub(logger);
  const subscriber = await getRedisPubSub(logger);
  assert(publisher !== undefined && subscriber !== undefined, "TransactionManager requires Redis Pub/Sub");

  const abortController = new AbortController();
  const manager = new TransactionManager({
    chainId: cfg.chainId,
    signer,
    runIdentifier: cfg.runIdentifier,
    publisher,
    subscriber,
    cache,
    logger,
    abortController,
    confirmationTimeoutMs: cfg.confirmationTimeoutMs,
  });

  const abort = (): void => abortController.abort();
  process.on("SIGHUP", abort);
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);

  logger[startupLogLevel(cfg)]({
    at: "TransactionManager#index",
    message: "TransactionManager started 🚦",
    chainId: cfg.chainId,
    eoa,
    botIdentifier: cfg.botIdentifier,
    runIdentifier: cfg.runIdentifier,
  });

  try {
    await manager.start();
  } finally {
    await Promise.allSettled([publisher.disconnect(), subscriber.disconnect()]);
  }
}
