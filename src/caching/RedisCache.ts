import { interfaces, constants } from "@across-protocol/sdk-v2";
import { RedisClient, objectWithBigNumberReviver, setRedisKey, winston } from "../utils";

/**
 * RedisCache is a caching mechanism that uses Redis as the backing store. It is used by the
 * Across SDK to cache data that is expensive to compute or retrieve from the blockchain. It
 * is designed to use the `CachingMechanismInterface` interface so that it can be used as a
 * drop-in in the SDK without the SDK needing to reason about the implementation details.
 */
export class RedisCache implements interfaces.CachingMechanismInterface {
  /**
   * The logger is optional, but if it is provided, it will be used to log debug messages
   */
  private readonly logger: winston.Logger | undefined;
  /**
   * The redisUrl is the URL of the redis server to connect to.
   */
  private readonly redisUrl: string;
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
  constructor(redisClient: RedisClient, logger?: winston.Logger) {
    this.logger = logger;
    this.redisClient = redisClient;
  }

  public async get<T>(key: string): Promise<T | undefined> {
    // Get the value from redis.
    const result = await this.redisClient.get(key);
    if (result) {
      // If the value exists, parse it and return it.
      return JSON.parse(result, objectWithBigNumberReviver);
    } else {
      // If the value does not exist, return undefined.
      return undefined;
    }
  }

  public async set<T>(key: string, value: T, ttl: number = constants.DEFAULT_CACHING_TTL): Promise<string | undefined> {
    // Call the setRedisKey function to set the value in redis.
    await setRedisKey(key, JSON.stringify(value), this.redisClient, ttl);
    // Return key to indicate that the value was set successfully.
    return key;
  }
}
