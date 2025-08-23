import { interfaces } from "@across-protocol/sdk";
import { RedisClient } from "../utils";

export class RedisPubSub implements interfaces.PubSubMechanismInterface {
  constructor(private readonly redisClient: RedisClient) {
    this.redisClient = redisClient;
  }

  async sub(channel: string, listener: (message: string, channel: string) => void): Promise<void> {
    await this.redisClient.sub(channel, listener);
  }

  async pub(channel: string, message: string): Promise<number> {
    return this.redisClient.pub(channel, message);
  }
}
