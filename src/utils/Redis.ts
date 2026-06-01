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
    redisClient = createClient({
      url,
      socket: {
        reconnectStrategy,
        // Enable TCP keepalive (initial delay 5s). node-redis v5's default is
        // also 5_000, but we pin it explicitly to guard against config drift.
        keepAlive: 5_000,
      },
      // Send a Redis-level PING every 30s when the connection is idle. This
      // surfaces a half-open socket faster than TCP keepalive alone and keeps
      // the connection warm against any intermediary (VPC connector / LB)
      // that may evict idle TCP flows.
      pingInterval: 30_000,
    });
    redisClient.on("error", (err) => logger?.warn({ at: "RedisClient", message: "Redis error", cause: String(err) }));
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
