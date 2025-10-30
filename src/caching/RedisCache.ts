import assert from "assert";
import { interfaces, constants } from "@across-protocol/sdk";
import { RedisClient, setRedisKey } from "../utils";

interface RedisCacheInterface extends interfaces.CachingMechanismInterface {
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
  /**
   * The redisClient is the redis client that is used to communicate with the redis server.
   * It is instantiated lazily when the `instantiate` method is called.
   */
  private redisClient: RedisClient | undefined;

  /**
   * The constructor takes in the redisClient.
   * @param redisClient The redis client to use for caching.
   */
  constructor(redisClient: RedisClient) {
    this.redisClient = redisClient;
  }

  public async get<T>(key: string): Promise<T | undefined> {
    // Get the value from redis.
    return this.redisClient.get(key) as T;
  }

  public async ttl(key: string): Promise<number | undefined> {
    return this.redisClient.ttl(key);
  }

  public async set<T>(key: string, value: T, ttl: number = constants.DEFAULT_CACHING_TTL): Promise<string | undefined> {
    // Call the setRedisKey function to set the value in redis.
    await setRedisKey(key, String(value), this.redisClient, ttl);
    // Return key to indicate that the value was set successfully.
    return key;
  }

  public decr(key: string): Promise<number> {
    return this.decrBy(key, 1);
  }

  public decrBy(key: string, amount: number): Promise<number> {
    assert(amount >= 0);
    return this.redisClient.decrBy(key, amount);
  }

  public incr(key: string): Promise<number> {
    return this.incrBy(key, 1);
  }

  public incrBy(key: string, amount: number): Promise<number> {
    assert(amount >= 0);
    return this.redisClient.incrBy(key, amount);
  }

  public async pub(channel: string, message: string): Promise<number> {
    return await this.redisClient.pub(channel, message);
  }

  public async sub(channel: string, listener: (message: string, channel: string) => void): Promise<number> {
    return await this.redisClient.sub(channel, listener);
  }
}
