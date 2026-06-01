import { createClient, RedisClientType as RedisClient } from "redis";
import dotenv from "dotenv";
import winston from "winston";
import { isDefined } from "./TypeGuards";
dotenv.config();

export type { RedisClient };

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export async function connectRedisClient(logger?: winston.Logger, url = REDIS_URL): Promise<RedisClient> {
  const reconnectStrategy = (retries: number, cause: Error): number | Error => {
    // Cap reconnection attempts to avoid livelock.
    const MAX_RETRIES = 10;

    if (retries >= MAX_RETRIES) {
      logger?.error({
        at: "RedisClient",
        message: `Redis connection failed after ${MAX_RETRIES} retries. Giving up.`,
        cause: String(cause),
      });
      return new Error(`Redis connection failed after ${MAX_RETRIES} retries`);
    }

    // Exponential backoff (2^n * 50ms, capped at 2000ms) plus 0–200ms jitter.
    const jitter = Math.floor(Math.random() * 200);
    const delay = Math.min(Math.pow(2, retries) * 50, 2000);
    logger?.debug({
      at: "RedisClient",
      message: `Lost redis connection, retrying in ${delay} ms (attempt ${retries + 1}/${MAX_RETRIES}).`,
      cause: String(cause),
    });
    return delay + jitter;
  };

  let redisClient: RedisClient | undefined = undefined;
  try {
    redisClient = createClient({ url, socket: { reconnectStrategy } });

    // node-redis emits one `error` event per pending command at the moment a
    // socket resets, so a single disconnect can produce a burst of 10–25
    // identical warnings. Coalesce events with the same cause within
    // ERROR_DEBOUNCE_MS into one log line, suffixed with the count when > 1.
    const ERROR_DEBOUNCE_MS = 1_000;
    let pendingErrorCause: string | undefined;
    let pendingErrorCount = 0;
    let flushTimer: NodeJS.Timeout | undefined;
    const flushErrors = (): void => {
      flushTimer = undefined;
      if (pendingErrorCount === 0) return;
      logger?.warn({
        at: "RedisClient",
        message: pendingErrorCount > 1 ? `Redis error (x${pendingErrorCount})` : "Redis error",
        cause: pendingErrorCause,
      });
      pendingErrorCount = 0;
      pendingErrorCause = undefined;
    };

    redisClient.on("error", (err) => {
      const cause = String(err);
      if (pendingErrorCause !== cause) {
        flushErrors();
        pendingErrorCause = cause;
      }
      pendingErrorCount += 1;
      if (!flushTimer) {
        flushTimer = setTimeout(flushErrors, ERROR_DEBOUNCE_MS);
      }
    });
    redisClient.on("ready", () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushErrors();
      }
      logger?.info({ at: "RedisClient", message: "Redis client ready.", url });
    });
    redisClient.on("end", () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushErrors();
      }
    });

    await redisClient.connect();
    return redisClient;
  } catch (err) {
    if (isDefined(redisClient)) {
      await disconnectRedisClient(redisClient, logger);
    }
    logger?.debug({
      at: "RedisClient#connect",
      message: `Failed to connect to redis server at ${url}.`,
      cause: String(err),
    });
    throw err;
  }
}

/**
 * Disconnect a redis client. Swallows errors and logs the outcome — disconnect
 * is best-effort and should not propagate failures to shutdown paths.
 */
export async function disconnectRedisClient(client: RedisClient, logger?: winston.Logger): Promise<void> {
  let disconnectSuccessful = true;
  try {
    await client.close();
  } catch (_e) {
    disconnectSuccessful = false;
  }
  const url = client.options?.url ?? "unknown";
  logger?.debug({
    at: "RedisClient#disconnect",
    message: `Disconnected from redis server at ${url} successfully? ${disconnectSuccessful}`,
  });
}

// Shared RedisClient registry, keyed by URL. Cache consumers multiplex over
// these — namespacing is a key-prefix concern and does not require dedicated
// connections. Pub/sub and stream consumers must call connectRedisClient
// directly to get their own dedicated socket, since SUBSCRIBE / blocking
// XREADGROUP monopolise the connection.
const clients: { [url: string]: Promise<RedisClient> } = {};

export async function getRedisClient(logger?: winston.Logger, url = REDIS_URL): Promise<RedisClient> {
  if (!isDefined(clients[url])) {
    clients[url] = connectRedisClient(logger, url);
  }
  try {
    return await clients[url];
  } catch (err) {
    // Drop the cached promise on failure so the next caller can retry.
    delete clients[url];
    throw err;
  }
}

export async function disconnectRedisClients(logger?: winston.Logger): Promise<void> {
  for (const [url, clientPromise] of Object.entries(clients)) {
    delete clients[url];
    try {
      const client = await clientPromise;
      await disconnectRedisClient(client, logger);
    } catch (err) {
      logger?.debug({
        at: "RedisClient#disconnectRedisClients",
        message: "Failed to disconnect from redis server.",
        url,
        cause: String(err),
      });
    }
  }
}
