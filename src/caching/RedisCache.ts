import { interfaces } from "@across-protocol/sdk-v2";
import { RedisClient, getRedis, objectWithBigNumberReviver, setRedisKey, winston } from "../utils";

export class RedisCache implements interfaces.CachingMechanismInterface {
  private readonly logger: winston.Logger | undefined;
  private readonly redisUrl: string;
  private isInstantiated: boolean;
  private redisClient: RedisClient | undefined;

  constructor(redisUrl: string, logger?: winston.Logger) {
    this.logger = logger;
    this.redisUrl = redisUrl;
    this.redisClient = undefined;
  }

  public async instantiate(): Promise<void> {
    if (!this.isInstantiated) {
      this.redisClient = await getRedis(this.logger, this.redisUrl);
    }
  }

  public async get<T>(key: string): Promise<T> {
    if (!this.redisClient) {
      throw new Error("Redis client not instantiated");
    }
    const result = await this.redisClient.get(key);
    if (result) {
      return JSON.parse(result, objectWithBigNumberReviver);
    }
  }

  public async set<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    if (!this.redisClient) {
      throw new Error("Redis client not instantiated");
    }
    await setRedisKey(key, JSON.stringify(value), this.redisClient, ttl);
    return true;
  }
}
