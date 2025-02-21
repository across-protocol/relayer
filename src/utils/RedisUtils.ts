import { assert, toBN, BigNumberish, isDefined } from "./";
import { REDIS_URL_DEFAULT } from "../common/Constants";
import { createClient } from "redis4";
import winston from "winston";
import { Deposit, Fill, CachingMechanismInterface } from "../interfaces";
import dotenv from "dotenv";
import { RedisCache } from "../caching/RedisCache";
import { constants } from "@across-protocol/sdk";
dotenv.config();

const globalNamespace: string | undefined = process.env.GLOBAL_CACHE_NAMESPACE
  ? String(process.env.GLOBAL_CACHE_NAMESPACE)
  : undefined;

export type _RedisClient = ReturnType<typeof createClient>;

export class RedisClient {
  constructor(
    private readonly client: _RedisClient,
    private readonly namespace?: string,
    private readonly logger?: winston.Logger
  ) {
    this.logger?.debug({
      at: "RedisClient#constructor",
      message: isDefined(namespace) ? `Created redis client with namespace ${namespace}` : "Created redis client.",
    });
  }

  private getNamespacedKey(key: string): string {
    return isDefined(this.namespace) ? `${this.namespace}:${key}` : key;
  }

  get url(): string {
    return this.client.options.url;
  }

  async get(key: string): Promise<string | undefined> {
    return this.client.get(this.getNamespacedKey(key));
  }

  async set(key: string, val: string, expirySeconds = constants.DEFAULT_CACHING_TTL): Promise<void> {
    // Apply namespace to key.
    key = this.getNamespacedKey(key);
    if (expirySeconds === Number.POSITIVE_INFINITY) {
      // No TTL
      await this.client.set(key, val);
    } else if (expirySeconds > 0) {
      // EX: Expire key after expirySeconds.
      await this.client.set(key, val, { EX: expirySeconds });
    } else {
      if (expirySeconds <= 0) {
        this.logger?.warn({
          at: "RedisClient#setRedisKey",
          message: `Tried to set key ${key} with expirySeconds = ${expirySeconds}. This shouldn't be allowed.`,
        });
      }
      await this.client.set(key, val);
    }
  }

  async disconnect(): Promise<void> {
    await disconnectRedisClient(this.client, this.logger);
  }
}

// Avoid caching calls that are recent enough to be affected by things like reorgs.
// Current time must be >= 15 minutes past the event timestamp for it to be stable enough to cache.
export const REDIS_CACHEABLE_AGE = 15 * 60;

export const REDIS_URL = process.env.REDIS_URL || REDIS_URL_DEFAULT;

// Make the redis client for a particular url essentially a singleton.
const redisClients: { [url: string]: RedisClient } = {};

export async function getRedis(logger?: winston.Logger, url = REDIS_URL): Promise<RedisClient | undefined> {
  if (!redisClients[url]) {
    let redisClient: _RedisClient | undefined = undefined;
    const reconnectStrategy = (retries: number): number | Error => {
      // Just implement the default reconnection strategy:
      // https://github.com/redis/node-redis/blob/558ebb4d25f2cbeb707cb601d4bd11014a6a6992/docs/client-configuration.md

      // Generate a random jitter between 0 – 200 ms:
      const jitter = Math.floor(Math.random() * 200);
      // Delay is an exponential back off, (times^2) * 50 ms, with a maximum value of 2000 ms:
      const delay = Math.min(Math.pow(2, retries) * 50, 2000);
      logger?.debug({
        at: "RedisUtils",
        message: `Lost redis connection, retrying in ${delay} ms.`,
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
      redisClients[url] = new RedisClient(redisClient, globalNamespace);
    } catch (err) {
      delete redisClients[url];
      await disconnectRedisClient(redisClient, logger);
      logger?.debug({
        at: "RedisUtils#getRedis",
        message: `Failed to connect to redis server at ${url}.`,
        error: String(err),
      });
    }
  }

  return redisClients[url];
}

export async function getRedisCache(
  logger?: winston.Logger,
  url?: string
): Promise<CachingMechanismInterface | undefined> {
  // Don't permit redis to be used in test.
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }

  const client = await getRedis(logger, url);
  if (client) {
    return new RedisCache(client);
  }
}

export async function setRedisKey(
  key: string,
  val: string,
  redisClient: RedisClient,
  expirySeconds = constants.DEFAULT_CACHING_TTL
): Promise<void> {
  await redisClient.set(key, val, expirySeconds);
}

export function getRedisDepositKey(depositOrFill: Deposit | Fill): string {
  return `deposit_${depositOrFill.originChainId}_${depositOrFill.depositId.toString()}`;
}

export async function setDeposit(
  deposit: Deposit,
  currentChainTime: number,
  redisClient: RedisClient,
  expirySeconds = 0
): Promise<void> {
  if (shouldCache(deposit.quoteTimestamp, currentChainTime)) {
    await setRedisKey(getRedisDepositKey(deposit), JSON.stringify(deposit), redisClient, expirySeconds);
  }
}

export async function getDeposit(key: string, redisClient: RedisClient): Promise<Deposit | undefined> {
  const depositRaw = await redisClient.get(key);
  if (depositRaw) {
    return JSON.parse(depositRaw, objectWithBigNumberReviver);
  }
}

export async function disconnectRedisClients(logger?: winston.Logger): Promise<void> {
  // todo understand why redisClients arent't GCed automagically.
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

// JSON.stringify(object) ends up stringfying BigNumber objects as "{type:BigNumber,hex...}" so we can pass
// this reviver function as the second arg to JSON.parse to instruct it to correctly revive a stringified
// object with BigNumber values.
export function objectWithBigNumberReviver(_: string, value: { type: string; hex: BigNumberish }): unknown {
  if (typeof value !== "object" || value?.type !== "BigNumber") {
    return value;
  }
  return toBN(value.hex);
}

/**
 * An internal function to disconnect from a redis client. This function is designed to NOT throw an error if the
 * disconnect fails.
 * @param client The redis client to disconnect from.
 * @param logger An optional logger to use to log the disconnect.
 */
async function disconnectRedisClient(client: _RedisClient, logger?: winston.Logger): Promise<void> {
  let disconnectSuccessful = true;
  try {
    await client.disconnect();
  } catch (_e) {
    disconnectSuccessful = false;
  }
  const url = client.options.url ?? "unknown";
  logger?.debug({
    at: "RedisClient#disconnect",
    message: `Disconnected from redis server at ${url} successfully? ${disconnectSuccessful}`,
  });
}
