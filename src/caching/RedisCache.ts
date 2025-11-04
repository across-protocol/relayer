import assert from "assert";
import { interfaces, constants } from "@across-protocol/sdk";
import { isDefined } from "../utils";
import { createClient } from "redis4";
import winston from "winston";

export type RedisClient = ReturnType<typeof createClient>;

export interface RedisCacheInterface extends interfaces.CachingMechanismInterface, interfaces.PubSubMechanismInterface {
  decr(key: string): Promise<number>;
  decrBy(key: string, amount: number): Promise<number>;
  incr(key: string): Promise<number>;
  incrBy(key: string, amount: number): Promise<number>;
}

/**
 * RedisCache is a caching mechanism that uses Redis as the backing store. It is used by the
 * Across SDK to cache data that is expensive to compute or retrieve from the blockchain. It
 * is designed to use the `CachingMechanismInterface` interface so that it can be used as a
 * drop-in in the SDK without the SDK needing to reason about the implementation details.
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

  decr(key: string): Promise<number> {
    return this.decrBy(key, 1);
  }

  decrBy(key: string, amount: number): Promise<number> {
    assert(amount >= 0);
    return this.client.decrBy(key, amount);
  }

  incr(key: string): Promise<number> {
    return this.incrBy(key, 1);
  }

  incrBy(key: string, amount: number): Promise<number> {
    assert(amount >= 0);
    return this.client.incrBy(key, amount);
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
