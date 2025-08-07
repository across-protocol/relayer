import { interfaces, constants } from "@across-protocol/sdk";
import { RedisClient, setRedisKey } from "../utils";

/**
 * RedisCache is a caching mechanism that uses Redis as the backing store. It is used by the
 * Across SDK to cache data that is expensive to compute or retrieve from the blockchain. It
 * is designed to use the `CachingMechanismInterface` interface so that it can be used as a
 * drop-in in the SDK without the SDK needing to reason about the implementation details.
 */
export class RedisCache implements interfaces.CachingMechanismInterface {
  /**
   * The redisClient is the redis client that is used to communicate with the redis server.
   * It is instantiated lazily when the `instantiate` method is called.
   */
  private redisClient: RedisClient | undefined;

  /**
   * The constructor takes in the redisUrl and an optional logger.
   * @param redisUrl The URL of the redis server to connect to.
   * @param logger The logger to use to log debug messages.
   */
  constructor(redisClient: RedisClient) {
    this.redisClient = redisClient;
  }

  public async get<T>(key: string): Promise<T | undefined> {
    // Get the value from redis.
    return this.redisClient.get(key) as T;
  }

  public async set<T>(key: string, value: T, ttl: number = constants.DEFAULT_CACHING_TTL): Promise<string | undefined> {
    // Call the setRedisKey function to set the value in redis.
    await setRedisKey(key, String(value), this.redisClient, ttl);
    // Return key to indicate that the value was set successfully.
    return key;
  }

  public async pub(channel: string, message: string): Promise<number> {
    return await this.redisClient.pub(channel, message);
  }

  public async sub(channel: string, listener: (message: string, channel: string) => void): Promise<number> {
    return await this.redisClient.sub(channel, listener);
  }
}
