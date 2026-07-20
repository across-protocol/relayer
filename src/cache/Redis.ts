import assert from "assert";
import { interfaces, constants } from "@across-protocol/sdk";
import winston from "winston";
import { isDefined } from "../utils/TypeGuards";
import { disconnectRedisClient, getRedisClient, RedisClient } from "../utils/Redis";

export { RedisClient };

export interface RedisCacheInterface extends interfaces.CachingMechanismInterface {
  acquireLock(key: string, token: string, ttlMs: number): Promise<boolean>;
  decr(key: string): Promise<number>;
  decrBy(key: string, amount: number): Promise<number>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
  releaseLock(key: string, token: string): Promise<boolean>;
  renewLock(key: string, token: string, ttlMs: number): Promise<boolean>;
  incr(key: string): Promise<number>;
  incrBy(key: string, amount: number): Promise<number>;
  sAdd(key: string, value: string): Promise<number>;
  sIsMember(key: string, value: string): Promise<boolean>;
  sMembers(key: string): Promise<string[]>;
  sRem(key: string, value: string): Promise<number>;
  ttl(key: string): Promise<number | undefined>;
}

const globalNamespace = process.env.GLOBAL_CACHE_NAMESPACE || undefined;

// Track (url, namespace) tuples already announced so we log namespace resolution
// once per tuple rather than on every getRedisCache() call.
const namespaces = new Set<string>();

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
  ) {}

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

  async acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const reply = await this.client.set(this.getNamespacedKey(key), token, {
      expiration: { type: "PX", value: ttlMs },
      condition: "NX",
    });
    return reply === "OK";
  }

  async renewLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const reply = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      {
        keys: [this.getNamespacedKey(key)],
        arguments: [token, String(ttlMs)],
      }
    );
    return reply === 1;
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    const reply = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      {
        keys: [this.getNamespacedKey(key)],
        arguments: [token],
      }
    );
    return reply === 1;
  }

  sAdd(key: string, value: string): Promise<number> {
    return this.client.sAdd(this.getNamespacedKey(key), value);
  }

  async sIsMember(key: string, value: string): Promise<boolean> {
    return Boolean(await this.client.sIsMember(this.getNamespacedKey(key), value));
  }

  sMembers(key: string): Promise<string[]> {
    return this.client.sMembers(this.getNamespacedKey(key));
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    return Boolean(await this.client.expire(this.getNamespacedKey(key), seconds));
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

  const resolvedUrl = client.options?.url ?? "unknown";
  const announceKey = `${resolvedUrl}|${namespace ?? ""}`;
  if (!namespaces.has(announceKey)) {
    namespaces.add(announceKey);
    logger?.debug({
      at: "RedisCache#getRedisCache",
      message: isDefined(namespace)
        ? `RedisCache initialized for namespace ${namespace} at ${resolvedUrl}.`
        : `RedisCache initialized (no namespace) at ${resolvedUrl}.`,
    });
  }

  return new RedisCache(client, namespace, logger);
}
