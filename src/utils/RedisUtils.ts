import { assert, toBN, BigNumberish, isDefined, getCurrentTime, isProviderErrorCount } from "./";
import { REDIS_URL_DEFAULT } from "../common/Constants";
import { createClient } from "redis4";
import winston from "winston";
import { Deposit, Fill, CachingMechanismInterface } from "../interfaces";
import dotenv from "dotenv";
import { RedisCache } from "../caching/RedisCache";
import { constants } from "@across-protocol/sdk-v2";
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

  async get(key: string): Promise<string | undefined> {
    return this.client.get(this.getNamespacedKey(key));
  }

  async set(key: string, val: string, expirySeconds = constants.DEFAULT_CACHING_TTL): Promise<void> {
    // Apply namespace to key.
    key = this.getNamespacedKey(key);
    if (expirySeconds > 0) {
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
    await this.client.disconnect();
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
    try {
      const redisClient = createClient({ url });
      await redisClient.connect();
      logger?.debug({
        at: "RedisUtils#getRedis",
        message: `Connected to redis server at ${url} successfully!`,
        dbSize: await redisClient.dbSize(),
      });
      redisClients[url] = new RedisClient(redisClient, globalNamespace);
    } catch (err) {
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
  return `deposit_${depositOrFill.originChainId}_${depositOrFill.depositId}`;
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

export async function disconnectRedisClient(logger?: winston.Logger): Promise<void> {
  const redisClient = await getRedis(logger);
  if (redisClient !== undefined) {
    // todo understand why redisClient isn't GCed automagically.
    logger.debug({ at: "disconnectRedisClient", message: "Disconnecting from redis server." });
    await redisClient.disconnect();
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

export type ProviderErrorCount = {
  chainId: number;
  provider: string;
  errorCount: number;
  lastTime: number;
};

function providerErrorCountKey(provider: string, chainId: number): string {
  return `provider_error_count_${provider}_${chainId}`;
}

/**
 * This function returns the ProviderErrorCount object for a given provider and chainId.
 * @param client The redis client
 * @param provider The provider name
 * @param chainId The chainId
 * @returns The ProviderErrorCount object. If the key doesn't exist, it will be created and returned with an errorCount of 0.
 * @note This function will always return an object, even if the key doesn't exist.
 * @note This function will mutate the redis database if the key doesn't exist.
 */
export async function getProviderErrorCount(
  client: RedisClient,
  provider: string,
  chainId: number
): Promise<ProviderErrorCount> {
  // Resolve the key for convenience
  const key = providerErrorCountKey(provider, chainId);
  // Get the value from redis
  const errorCount = await client.get(key);
  // Attempt to parse the object OR an empty object
  // Note: we want this to always return an object, even if it's empty
  const parsedValue = JSON.parse(errorCount ?? "{}");
  // Check if the parsed value is a ProviderErrorCount
  if (isProviderErrorCount(parsedValue)) {
    // If it is, return it
    return parsedValue;
  }
  // If not, create a new ProviderErrorCount object, set it
  // in redis, and return it
  else {
    return setProviderErrorCount(client, provider, chainId, {
      chainId,
      provider,
      errorCount: 0,
      lastTime: getCurrentTime(),
    });
  }
}

/**
 * This function sets the ProviderErrorCount object for a given provider and chainId.
 * @param client The redis client
 * @param provider The name of the provider
 * @param chainId The chainId
 * @param providerErrorCount The ProviderErrorCount object
 * @returns The ProviderErrorCount object that was just set.
 */
export async function setProviderErrorCount(
  client: RedisClient,
  provider: string,
  chainId: number,
  providerErrorCount: ProviderErrorCount
): Promise<ProviderErrorCount> {
  // Resolve the key for convenience
  const key = providerErrorCountKey(provider, chainId);
  // Set the value in redis
  await client.set(key, JSON.stringify(providerErrorCount), 86400); // Set the expiry to 1 day
  // Return the value that was just set
  return providerErrorCount;
}

/**
 * This function increments the errorCount for a given provider and chainId. It does so by using an exponential decay function.
 * @param client The redis client
 * @param provider The provider name
 * @param chainId The chainId
 * @returns The ProviderErrorCount object that was just updated.
 */
export async function incrementProviderErrorCount(
  client: RedisClient,
  provider: string,
  chainId: number
): Promise<ProviderErrorCount> {
  // Grab the ProviderErrorCount object from redis
  const providerErrorCount = await getProviderErrorCount(client, provider, chainId);
  // Find the time since the last error and normalize by the seconds in a day
  const timeSinceLastError = (getCurrentTime() - providerErrorCount.lastTime) / 86400; // 86400 seconds in a day
  // Calculate the decay factor with a modified exponential decay function
  // Note: the decay factor is calculated using the formula: e^(-t) where t is the time since the last error
  // Note: as the time increases, we tend towards 0
  // Note: we can enforce that anything over 1 day old will have a decay factor of 0
  const decayFactor = timeSinceLastError >= 1.0 ? 0 : Math.exp(-timeSinceLastError);
  // Calculate the new error count
  const newErrorCount = providerErrorCount.errorCount * decayFactor + 1;
  // Update the ProviderErrorCount object
  const updatedProviderErrorCount = {
    ...providerErrorCount,
    errorCount: newErrorCount,
    lastTime: getCurrentTime(),
  };
  // Set the ProviderErrorCount object in redis and return it
  return setProviderErrorCount(client, provider, chainId, updatedProviderErrorCount);
}
