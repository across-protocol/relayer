import { interfaces } from "@across-protocol/sdk";
import winston from "winston";
import { isDefined } from "../../utils/TypeGuards";
import { connectRedisClient, disconnectRedisClient, REDIS_URL, RedisClient } from "../../utils/redis";

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

export async function getRedisPubSub(logger?: winston.Logger, url = REDIS_URL): Promise<RedisPubSub | undefined> {
  // Don't permit redis to be used in test.
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }

  // Pub/sub requires its own dedicated socket: once SUBSCRIBE is issued, Redis forbids
  // regular commands on that connection. Build a fresh RedisClient rather than sharing
  // the cache singleton's socket.
  const client = await connectRedisClient(logger, url);
  return new RedisPubSub(client, logger);
}

export async function waitForPubSub(
  redisClient: RedisPubSub,
  channel: string,
  message: string,
  maxWaitMs = 60000
): Promise<boolean> {
  return new Promise((resolve) => {
    const abortController = new AbortController();
    const signal = abortController.signal;
    const listener = (msg: string, chl: string) => {
      if (chl === channel && msg !== message) {
        abortController.abort();
      }
    };
    void redisClient.sub(channel, listener);

    const timer = setTimeout(() => {
      void redisClient.unsub(channel, listener);
      resolve(false);
    }, maxWaitMs);

    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      void redisClient.unsub(channel, listener);
      resolve(true);
    });
  });
}
