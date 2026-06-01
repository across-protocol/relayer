import assert from "assert";
import { interfaces, constants } from "@across-protocol/sdk";
import { isDefined } from "../utils";
import { createClient } from "redis4";
import winston from "winston";

export type RedisClient = ReturnType<typeof createClient>;

export interface RedisCacheInterface extends interfaces.CachingMechanismInterface, interfaces.PubSubMechanismInterface {
  acquireLock(key: string, token: string, ttlMs: number): Promise<boolean>;
  decr(key: string): Promise<number>;
  decrBy(key: string, amount: number): Promise<number>;
  del(key: string): Promise<number>;
  get<T>(key: string): Promise<T | undefined>;
  releaseLock(key: string, token: string): Promise<boolean>;
  renewLock(key: string, token: string, ttlMs: number): Promise<boolean>;
  incr(key: string): Promise<number>;
  incrBy(key: string, amount: number): Promise<number>;
  set<T>(key: string, val: T, expirySeconds?: number): Promise<string | undefined>;
  ttl(key: string): Promise<number | undefined>;
}

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

  get url(): string {
    return this.client.options.url;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.client.get(this.getNamespacedKey(key)) as T;
  }

  async ttl(key: string): Promise<number | undefined> {
    return this.client.ttl(this.getNamespacedKey(key));
  }

  async set<T>(key: string, val: T, expirySeconds = constants.DEFAULT_CACHING_TTL): Promise<string | undefined> {
    // Apply namespace to key.
    key = this.getNamespacedKey(key);
    if (expirySeconds === Number.POSITIVE_INFINITY) {
      // No TTL
      return await this.client.set(key, String(val));
    } else if (expirySeconds > 0) {
      // EX: Expire key after expirySeconds.
      return await this.client.set(key, String(val), { EX: expirySeconds });
    } else {
      if (expirySeconds <= 0) {
        this.logger?.warn({
          at: "RedisCache#set",
          message: `Tried to set key ${key} with expirySeconds = ${expirySeconds}. This shouldn't be allowed.`,
        });
      }
      return await this.client.set(key, String(val));
    }
  }

  async acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const reply = await this.client.set(this.getNamespacedKey(key), token, { NX: true, PX: ttlMs });
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
    return this.decrBy(this.getNamespacedKey(key), 1);
  }

  decrBy(key: string, amount: number): Promise<number> {
    assert(amount >= 0);
    return this.client.decrBy(this.getNamespacedKey(key), amount);
  }

  incr(key: string): Promise<number> {
    return this.incrBy(this.getNamespacedKey(key), 1);
  }

  incrBy(key: string, amount: number): Promise<number> {
    assert(amount >= 0);
    return this.client.incrBy(this.getNamespacedKey(key), amount);
  }

  pub(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  async sub(channel: string, listener: (message: string, channel: string) => void): Promise<void> {
    await this.client.subscribe(channel, listener);
  }

  async duplicate(): Promise<RedisCache> {
    const newClient = this.client.duplicate();
    await newClient.connect();
    return new RedisCache(newClient, this.namespace, this.logger);
  }

  async disconnect(): Promise<void> {
    await disconnectRedisClient(this.client, this.logger);
  }
}

/**
 * An internal function to disconnect from a redis client. This function is designed to NOT throw an error if the
 * disconnect fails.
 * @param client The redis client to disconnect from.
 * @param logger An optional logger to use to log the disconnect.
 */
export async function disconnectRedisClient(client: RedisClient, logger?: winston.Logger): Promise<void> {
  let disconnectSuccessful = true;
  try {
    await client.disconnect();
  } catch (_e) {
    disconnectSuccessful = false;
  }
  const url = client.options.url ?? "unknown";
  logger?.debug({
    at: "RedisCache#disconnect",
    message: `Disconnected from redis server at ${url} successfully? ${disconnectSuccessful}`,
  });
}
