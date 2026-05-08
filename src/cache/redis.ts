import assert from "assert";
import { interfaces, constants } from "@across-protocol/sdk";
import winston from "winston";
import { isDefined } from "../utils/TypeGuards";
import { disconnectRedisClient, getRedisClient, RedisClient } from "../utils/redis";

export interface RedisCacheInterface extends interfaces.CachingMechanismInterface {
  decr(key: string): Promise<number>;
  decrBy(key: string, amount: number): Promise<number>;
  incr(key: string): Promise<number>;
  incrBy(key: string, amount: number): Promise<number>;
}

const globalNamespace = process.env.GLOBAL_CACHE_NAMESPACE || undefined;

/**
 * RedisCache is a caching mechanism that uses Redis as the backing store. It is used by the
 * Across SDK to cache data that is expensive to compute or retrieve from the blockchain. It
 * is designed to use the `CachingMechanismInterface` interface so that it can be used as a
 * drop-in replacement in the SDK without the SDK needing to reason about the implementation details.
 */
export class RedisCache implements RedisCacheInterface {
  constructor(
    private readonly client: RedisClient,
    private readonly namespace?: string,
    private readonly logger?: winston.Logger
  ) {
    this.logger?.debug({
      at: "RedisCache#constructor",
      message: isDefined(namespace) ? `Created redis client with namespace ${namespace}` : "Created redis client.",
    });
  }

  private getNamespacedKey(key: string): string {
    return isDefined(this.namespace) ? `${this.namespace}:${key}` : key;
  }

  get url(): string | undefined {
    return this.client.options?.url;
  }

  async get<T>(key?: string): Promise<T | null> {
    if (key === undefined) {
      return null;
    }
    return (await this.client.get(this.getNamespacedKey(key))) as T | null;
  }

  async ttl(key: string): Promise<number | undefined> {
    return this.client.ttl(this.getNamespacedKey(key));
  }

  async set<T>(key: string, val: T, expirySeconds = constants.DEFAULT_CACHING_TTL): Promise<string | undefined> {
    // Apply namespace to key.
    key = this.getNamespacedKey(key);
    // The redis client returns `string | null`; the interface contract is `string | undefined`, so collapse null → undefined.
    if (expirySeconds === Number.POSITIVE_INFINITY) {
      // No TTL
      return (await this.client.set(key, String(val))) ?? undefined;
    } else if (expirySeconds > 0) {
      // Expire key after expirySeconds.
      return (
        (await this.client.set(key, String(val), { expiration: { type: "EX", value: expirySeconds } })) ?? undefined
      );
    }

    this.logger?.warn({
      at: "RedisCache#set",
      message: `Rejecting set for key ${key} with non-positive expirySeconds (${expirySeconds}).`,
    });
  }

  sAdd(key: string, value: string): Promise<number> {
    return this.client.sAdd(this.getNamespacedKey(key), value);
  }

  sMembers(key: string): Promise<string[]> {
    return this.client.sMembers(this.getNamespacedKey(key));
  }

  sRem(key: string, value: string): Promise<number> {
    return this.client.sRem(this.getNamespacedKey(key), value);
  }

  del(key: string): Promise<number> {
    return this.client.del(this.getNamespacedKey(key));
  }

  decr(key: string): Promise<number> {
    return this.decrBy(key, 1);
  }

  decrBy(key: string, amount: number): Promise<number> {
    assert(amount >= 0);
    return this.client.decrBy(this.getNamespacedKey(key), amount);
  }

  incr(key: string): Promise<number> {
    return this.incrBy(key, 1);
  }

  incrBy(key: string, amount: number): Promise<number> {
    assert(amount >= 0);
    return this.client.incrBy(this.getNamespacedKey(key), amount);
  }

  async disconnect(): Promise<void> {
    await disconnectRedisClient(this.client, this.logger);
  }
}

export async function getRedisCache(
  logger?: winston.Logger,
  url?: string,
  customNamespace?: string
): Promise<RedisCache | undefined> {
  // Don't permit redis to be used in test.
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }

  const namespace = customNamespace || globalNamespace;
  const client = await getRedisClient(logger, url);
  return new RedisCache(client, namespace, logger);
}
