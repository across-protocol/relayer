import { assert, toBN, BigNumberish, isDefined } from "./";
import { REDIS_URL_DEFAULT } from "../common/Constants";
import { createClient } from "redis4";
import winston from "winston";
import { Deposit, Fill } from "../interfaces";
import dotenv from "dotenv";
import { disconnectRedisClient, RedisCache, RedisCacheInterface, RedisClient } from "../caching/RedisCache";
dotenv.config();

const globalNamespace: string | undefined = process.env.GLOBAL_CACHE_NAMESPACE
  ? String(process.env.GLOBAL_CACHE_NAMESPACE)
  : undefined;

// Avoid caching calls that are recent enough to be affected by things like reorgs.
// Current time must be >= 15 minutes past the event timestamp for it to be stable enough to cache.
export const REDIS_CACHEABLE_AGE = 15 * 60;

export const REDIS_URL = process.env.REDIS_URL || REDIS_URL_DEFAULT;

// Make the redis client for a particular url + namespace essentially a singleton.
// Stores promises to avoid TOCTOU races when multiple callers request the same client concurrently.
const redisClients: { [key: string]: Promise<RedisCache> } = {};

async function _getRedis(
  logger?: winston.Logger,
  url = REDIS_URL,
  customNamespace?: string
): Promise<RedisCache | undefined> {
  const namespace = customNamespace || globalNamespace;
  const redisInstanceKey = namespace ? `${url}-${namespace}` : url;
  if (!isDefined(redisClients[redisInstanceKey])) {
    // Store the promise immediately so concurrent callers share the same connection attempt.
    redisClients[redisInstanceKey] = _createRedisClient(logger, url, namespace);
  }

  try {
    return await redisClients[redisInstanceKey];
  } catch (err) {
    // On failure, remove the cached promise so the next caller can retry.
    delete redisClients[redisInstanceKey];
    throw err;
  }
}

async function _createRedisClient(
  logger: winston.Logger | undefined,
  url: string,
  namespace?: string
): Promise<RedisCache> {
  const redisInstanceKey = namespace ? `${url}-${namespace}` : url;
  logger?.debug({
    at: "RedisUtils#_getRedis",
    message: `Creating new redis client instance with key ${redisInstanceKey}`,
  });

  let redisClient: RedisClient | undefined = undefined;
  const reconnectStrategy = (retries: number): number | Error => {
    // Set a maximum retry limit to prevent infinite reconnection attempts
    const MAX_RETRIES = 10;

    if (retries >= MAX_RETRIES) {
      logger?.error({
        at: "RedisUtils",
        message: `Redis connection failed after ${MAX_RETRIES} retries. Giving up.`,
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
    });
    return delay + jitter;
  };

  try {
    redisClient = createClient({ url, socket: { reconnectStrategy } });
    redisClient.on("error", (err) => logger?.warn({ at: "RedisUtils", message: "Redis error", error: String(err) }));
    await redisClient.connect();
    logger?.debug({
      at: "RedisUtils#getRedis",
      message: `Connected to redis server at ${url} successfully!`,
      dbSize: await redisClient.dbSize(),
    });
    return new RedisCache(redisClient, namespace);
  } catch (err) {
    await disconnectRedisClient(redisClient, logger);
    logger?.debug({
      at: "RedisUtils#getRedis",
      message: `Failed to connect to redis server at ${url}.`,
      error: String(err),
    });
    throw err;
  }
}

export async function getRedisCache(
  logger?: winston.Logger,
  url?: string,
  customNamespace?: string
): Promise<RedisCacheInterface | undefined> {
  // Don't permit redis to be used in test.
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }

  return await _getRedis(logger, url, customNamespace);
}

export async function getRedisPubSub(logger?: winston.Logger, url?: string): Promise<RedisCacheInterface | undefined> {
  // Don't permit redis to be used in test.
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }

  const client = await _getRedis(logger, url);
  if (client) {
    // since getRedis returns the same client instance for the same url,
    // we need to duplicate it before creating a new RedisPubSub instance
    return await client.duplicate();
  }
}

export function getRedisDepositKey(depositOrFill: Deposit | Fill): string {
  return `deposit_${depositOrFill.originChainId}_${depositOrFill.depositId.toString()}`;
}

export async function setDeposit(
  deposit: Deposit,
  currentChainTime: number,
  redisClient: RedisCache,
  expirySeconds = 0
): Promise<void> {
  if (shouldCache(deposit.quoteTimestamp, currentChainTime)) {
    await redisClient.set(getRedisDepositKey(deposit), JSON.stringify(deposit), expirySeconds);
  }
}

export async function getDeposit(key: string, redisClient: RedisCache): Promise<Deposit | undefined> {
  const depositRaw = await redisClient.get<string>(key);
  if (depositRaw) {
    return JSON.parse(depositRaw, objectWithBigNumberReviver);
  }
}

export async function waitForPubSub(
  redisClient: RedisCacheInterface,
  channel: string,
  message: string,
  maxWaitMs = 60000
): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = (msg: string, chl: string) => {
      if (chl === channel && msg !== message) {
        cleanup(true);
      }
    };

    const timer = setTimeout(() => cleanup(false), maxWaitMs);

    let settled = false;
    const cleanup = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void redisClient.unsub(channel, listener);
      resolve(result);
    };

    void redisClient.sub(channel, listener);
  });
}

export async function disconnectRedisClients(logger?: winston.Logger): Promise<void> {
  const clients = Object.entries(redisClients);
  for (const [key, clientPromise] of clients) {
    const logParams: Record<string, unknown> = {
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
      logParams["success"] = true;
    } catch (e) {
      logParams["success"] = false;
      logParams["error"] = e;
    }
    logger?.debug(logParams);
  }
}

export function shouldCache(eventTimestamp: number, latestTime: number): boolean {
  assert(eventTimestamp.toString().length === 10, "eventTimestamp must be in seconds");
  assert(latestTime.toString().length === 10, "eventTimestamp must be in seconds");
  return latestTime - eventTimestamp >= REDIS_CACHEABLE_AGE;
}

// JSON.stringify(object) ends up stringifying BigNumber objects as "{type:BigNumber,hex...}" so we can pass
// this reviver function as the second arg to JSON.parse to instruct it to correctly revive a stringified
// object with BigNumber values.
export function objectWithBigNumberReviver(_: string, value: { type: string; hex: BigNumberish }): unknown {
  if (typeof value !== "object" || value?.type !== "BigNumber") {
    return value;
  }
  return toBN(value.hex);
}
