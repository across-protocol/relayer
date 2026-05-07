import { isDefined } from "./";
import { REDIS_URL_DEFAULT } from "../common/Constants";
import { createClient } from "redis";
import winston from "winston";
import dotenv from "dotenv";
import { disconnectRedisClient, RedisCache, RedisClient } from "../caching/RedisCache";
import { RedisPubSub } from "../caching/RedisPubSub";
import { RedisStream } from "../messaging/redis/Stream";
dotenv.config();

const globalNamespace: string | undefined = process.env.GLOBAL_CACHE_NAMESPACE
  ? String(process.env.GLOBAL_CACHE_NAMESPACE)
  : undefined;

export const REDIS_URL = process.env.REDIS_URL || REDIS_URL_DEFAULT;

// Make the redis client for a particular url + namespace essentially a singleton.
// Stores promises to avoid TOCTOU races when multiple callers request the same client concurrently.
const redisClients: { [key: string]: Promise<RedisCache> } = {};

async function _getRedis(
  logger?: winston.Logger,
  url = REDIS_URL,
  customNamespace?: string,
  label?: string
): Promise<RedisCache | undefined> {
  const namespace = customNamespace || globalNamespace;
  const redisInstanceKey = namespace ? `${url}-${namespace}` : url;
  if (!isDefined(redisClients[redisInstanceKey])) {
    // Store the promise immediately so concurrent callers share the same connection attempt.
    redisClients[redisInstanceKey] = _createRedisClient(logger, url, namespace, label);
  }

  try {
    return await redisClients[redisInstanceKey];
  } catch (err) {
    // On failure, remove the cached promise so the next caller can retry.
    delete redisClients[redisInstanceKey];
    throw err;
  }
}

async function _createRawRedisClient(
  logger: winston.Logger | undefined,
  url: string,
  label?: string
): Promise<RedisClient> {
  const reconnectStrategy = (retries: number): number | Error => {
    // Set a maximum retry limit to prevent infinite reconnection attempts
    const MAX_RETRIES = 10;

    if (retries >= MAX_RETRIES) {
      logger?.error({
        at: "RedisUtils",
        message: `Redis connection failed after ${MAX_RETRIES} retries. Giving up.`,
        label,
      });
      return new Error(`Redis connection failed after ${MAX_RETRIES} retries`);
    }

    // Generate a random jitter between 0 – 200 ms:
    const jitter = Math.floor(Math.random() * 200);
    // Delay is an exponential back off, (times^2) * 50 ms, with a maximum value of 2000 ms:
    const delay = Math.min(Math.pow(2, retries) * 50, 2000);
    logger?.debug({
      at: "RedisUtils",
      message: `Lost redis connection, retrying in ${delay} ms (attempt ${retries + 1}/${MAX_RETRIES}).`,
      label,
    });
    return delay + jitter;
  };

  let redisClient: RedisClient | undefined = undefined;
  try {
    redisClient = createClient({ url, socket: { reconnectStrategy } });
    redisClient.on("error", (err) =>
      logger?.warn({ at: "RedisUtils", message: "Redis error", error: String(err), label })
    );
    await redisClient.connect();
    return redisClient;
  } catch (err) {
    if (isDefined(redisClient)) {
      await disconnectRedisClient(redisClient, logger, label);
    }
    logger?.debug({
      at: "RedisUtils#getRedis",
      message: `Failed to connect to redis server at ${url}.`,
      error: String(err),
      label,
    });
    throw err;
  }
}

async function _createRedisClient(
  logger: winston.Logger | undefined,
  url: string,
  namespace?: string,
  label?: string
): Promise<RedisCache> {
  const redisInstanceKey = namespace ? `${url}-${namespace}` : url;
  logger?.debug({
    at: "RedisUtils#_getRedis",
    message: `Creating new redis client instance with key ${redisInstanceKey}`,
    label,
  });

  const redisClient = await _createRawRedisClient(logger, url, label);
  logger?.debug({
    at: "RedisUtils#getRedis",
    message: `Connected to redis server at ${url} successfully!`,
    dbSize: await redisClient.dbSize(),
    label,
  });
  return new RedisCache(redisClient, namespace, logger, label);
}

export async function getRedisCache(
  logger?: winston.Logger,
  url?: string,
  customNamespace?: string,
  label?: string
): Promise<RedisCache | undefined> {
  // Don't permit redis to be used in test.
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }

  return await _getRedis(logger, url, customNamespace, label);
}

export async function getRedisPubSub(
  logger?: winston.Logger,
  url = REDIS_URL,
  label?: string
): Promise<RedisPubSub | undefined> {
  // Don't permit redis to be used in test.
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }

  // Pub/sub requires its own dedicated socket: once SUBSCRIBE is issued, Redis forbids
  // regular commands on that connection. Build a fresh RedisClient rather than sharing
  // the cache singleton's socket.
  const client = await _createRawRedisClient(logger, url, label);
  return new RedisPubSub(client, logger);
}

export async function getRedisStream(
  logger?: winston.Logger,
  url = REDIS_URL,
  label?: string
): Promise<RedisStream | undefined> {
  // Don't permit redis to be used in test.
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }

  // Each consumer issues blocking XREADGROUP, which monopolises the connection
  // for the duration of the block. Always build a fresh RedisClient.
  const client = await _createRawRedisClient(logger, url, label);
  return new RedisStream(client, logger, { label });
}

export async function waitForPubSub(
  redisClient: RedisPubSub,
  channel: string,
  message: string,
  maxWaitMs = 60000
): Promise<boolean> {
  return new Promise((resolve) => {
    const abortController = new AbortController();
    const signal = abortController.signal;
    const listener = (msg: string, chl: string) => {
      if (chl === channel && msg !== message) {
        abortController.abort();
      }
    };
    void redisClient.sub(channel, listener);

    const timer = setTimeout(() => {
      void redisClient.unsub(channel, listener);
      resolve(false);
    }, maxWaitMs);

    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      void redisClient.unsub(channel, listener);
      resolve(true);
    });
  });
}

export async function disconnectRedisClients(logger?: winston.Logger): Promise<void> {
  const clients = Object.entries(redisClients);
  for (const [key, clientPromise] of clients) {
    const logParams: { at: string; message: string; key: string; success?: boolean; error?: unknown } = {
      at: "RedisUtils#disconnectRedisClient",
      message: "Disconnecting from redis server.",
      key,
    };
    // We should delete the client from our cache object before
    // we disconnect from redis.
    delete redisClients[key];
    // We don't want to throw an error if we can't disconnect from redis.
    // We can log the error and continue.
    try {
      const client = await clientPromise;
      await client.disconnect();
      logParams.success = true;
    } catch (e) {
      logParams.success = false;
      logParams.error = e;
    }
    logger?.debug(logParams);
  }
}
