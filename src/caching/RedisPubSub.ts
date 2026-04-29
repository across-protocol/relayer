import { interfaces } from "@across-protocol/sdk";
import winston from "winston";
import { disconnectRedisClient, RedisClient } from "./RedisCache";

/**
 * RedisPubSub wraps a dedicated RedisClient connection that has been (or will be) placed
 * into Redis subscribe state. Once a connection has called SUBSCRIBE, the Redis protocol
 * forbids running regular commands (GET, SET, ...) on it — so pub/sub clients must own
 * their own socket, distinct from any cache client.
 */
export class RedisPubSub implements interfaces.PubSubMechanismInterface {
  constructor(
    private readonly client: RedisClient,
    private readonly logger?: winston.Logger
  ) {}

  pub(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  async sub(channel: string, listener: (message: string, channel: string) => void): Promise<void> {
    await this.client.subscribe(channel, listener);
  }

  async unsub(channel: string, listener: (message: string, channel: string) => void): Promise<void> {
    await this.client.unsubscribe(channel, listener);
  }

  async disconnect(): Promise<void> {
    await disconnectRedisClient(this.client, this.logger);
  }
}
