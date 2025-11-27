import { assert, toBN, BigNumberish, isDefined } from "./";
import { REDIS_URL_DEFAULT } from "../common/Constants";
import { createClient } from "redis4";
import winston from "winston";
import { Deposit, Fill, PubSubMechanismInterface } from "../interfaces";
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

// Make the redis client for a particular url essentially a singleton.
const redisClients: { [url: string]: RedisCache } = {};

async function _getRedis(logger?: winston.Logger, url = REDIS_URL): Promise<RedisCache | undefined> {
  if (!redisClients[url]) {
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
      redisClient.on("error", (err) => logger?.debug({ at: "RedisUtils", message: "Redis error", error: String(err) }));
      await redisClient.connect();
      logger?.debug({
        at: "RedisUtils#getRedis",
        message: `Connected to redis server at ${url} successfully!`,
        dbSize: await redisClient.dbSize(),
      });
      redisClients[url] = new RedisCache(redisClient, globalNamespace);
    } catch (err) {
      delete redisClients[url];
      await disconnectRedisClient(redisClient, logger);
      logger?.debug({
        at: "RedisUtils#getRedis",
        message: `Failed to connect to redis server at ${url}.`,
        error: String(err),
      });
      throw err;
    }
  }

  return redisClients[url];
}

export async function getRedisCache(logger?: winston.Logger, url?: string): Promise<RedisCacheInterface | undefined> {
  // Don't permit redis to be used in test.
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }

  return await _getRedis(logger, url);
}

export async function getRedisPubSub(
  logger?: winston.Logger,
  url?: string
): Promise<PubSubMechanismInterface | undefined> {
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
  redisClient: PubSubMechanismInterface,
  channel: string,
  message: string,
  maxWaitMs = 60000
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return new Promise((resolve, _reject) => {
    const abortController = new AbortController();
    const signal = abortController.signal;
    const listener = (msg: string, chl: string) => {
      if (chl === channel && msg !== message) {
        abortController.abort();
      }
    };
    void redisClient.sub(channel, listener);

    signal.addEventListener("abort", () => {
      resolve(true);
    });

    setTimeout(() => {
      resolve(false);
    }, maxWaitMs);
  });
}

export async function disconnectRedisClients(logger?: winston.Logger): Promise<void> {
  // todo understand why redisClients aren't GCed automagically.
  const clients = Object.entries(redisClients);
  for (const [url, client] of clients) {
    const logParams = {
      at: "RedisUtils#disconnectRedisClient",
      message: "Disconnecting from redis server.",
      url,
    };
    // We should delete the client from our cache object before
    // we disconnect from redis.
    delete redisClients[url];
    // We don't want to throw an error if we can't disconnect from redis.
    // We can log the error and continue.
    try {
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
