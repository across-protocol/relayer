import winston from "winston";
import { disconnectRedisClient, RedisClient } from "../../utils/Redis";
import { DeliveredMessage, MessageStream, PublishOptions, SubscribeOptions, Subscription } from "../MessageStream";

const PAYLOAD_FIELD = "payload";

const RECLAIM_INTERVAL_MS_DEFAULT = 30_000;
const RECLAIM_MIN_IDLE_MS_DEFAULT = 60_000;
const BLOCK_MS_DEFAULT = 5_000;
const RECLAIM_CURSOR_START = "0-0";

export interface RedisStreamOptions {
  // How often XAUTOCLAIM runs to recover entries from dead consumers. Default 30s.
  reclaimIntervalMs?: number;
  // Minimum idle before a pending entry is reclaim-eligible. Default 60s.
  reclaimMinIdleMs?: number;
  // Identifier surfaced in logs; disambiguates concurrent connections.
  label?: string;
}

// Redis Streams implementation of MessageStream. Stranded entries are recovered
// internally via a periodic XAUTOCLAIM merged into the message iterator.
export class RedisStream implements MessageStream {
  private readonly reclaimIntervalMs: number;
  private readonly reclaimMinIdleMs: number;
  private readonly label?: string;

  constructor(
    private readonly client: RedisClient,
    private readonly logger?: winston.Logger,
    opts: RedisStreamOptions = {}
  ) {
    this.reclaimIntervalMs = opts.reclaimIntervalMs ?? RECLAIM_INTERVAL_MS_DEFAULT;
    this.reclaimMinIdleMs = opts.reclaimMinIdleMs ?? RECLAIM_MIN_IDLE_MS_DEFAULT;
    this.label = opts.label;
  }

  async publish(topic: string, payload: string, opts: PublishOptions = {}): Promise<string> {
    if (opts.maxLen !== undefined) {
      return this.client.xAdd(
        topic,
        "*",
        { [PAYLOAD_FIELD]: payload },
        { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: opts.maxLen } }
      );
    }
    return this.client.xAdd(topic, "*", { [PAYLOAD_FIELD]: payload });
  }

  async subscribe(topic: string, opts: SubscribeOptions): Promise<Subscription> {
    await this.ensureGroup(topic, opts.group);
    return new RedisSubscription(this.client, topic, opts, {
      reclaimIntervalMs: this.reclaimIntervalMs,
      reclaimMinIdleMs: this.reclaimMinIdleMs,
      logger: this.logger,
    });
  }

  async disconnect(): Promise<void> {
    await disconnectRedisClient(this.client, this.logger);
  }

  private async ensureGroup(topic: string, group: string): Promise<void> {
    try {
      await this.client.xGroupCreate(topic, group, "$", { MKSTREAM: true });
    } catch (err) {
      // BUSYGROUP -> group already exists; idempotent.
      if (err instanceof Error && err.message.startsWith("BUSYGROUP")) {
        return;
      }
      throw err;
    }
  }
}

interface RedisSubscriptionConfig {
  reclaimIntervalMs: number;
  reclaimMinIdleMs: number;
  logger?: winston.Logger;
}

class RedisSubscription implements Subscription {
  // Internal abort source; combined with the optional external signal in `aborted`.
  private readonly closeController = new AbortController();
  private lastReclaimAt = 0;

  constructor(
    private readonly client: RedisClient,
    private readonly topic: string,
    private readonly opts: SubscribeOptions,
    private readonly config: RedisSubscriptionConfig
  ) {}

  private get aborted(): boolean {
    return this.closeController.signal.aborted || (this.opts.signal?.aborted ?? false);
  }

  async *messages(): AsyncIterableIterator<DeliveredMessage> {
    const { group, consumer, blockMs = BLOCK_MS_DEFAULT, count } = this.opts;
    while (!this.aborted) {
      // Periodic XAUTOCLAIM to recover entries from dead consumers.
      if (Date.now() - this.lastReclaimAt >= this.config.reclaimIntervalMs) {
        for await (const msg of this.reclaim(group, consumer, count)) {
          if (this.aborted) {
            return;
          }
          yield msg;
        }
        this.lastReclaimAt = Date.now();
      }

      let reply;
      try {
        reply = await this.client.xReadGroup(group, consumer, [{ key: this.topic, id: ">" }], {
          BLOCK: blockMs,
          COUNT: count,
        });
      } catch (err) {
        // Client teardown during shutdown surfaces here; swallow if aborted.
        if (this.aborted) {
          return;
        }
        throw err;
      }
      if (this.aborted) {
        return;
      }
      if (!reply) {
        continue;
      }
      const streamReply = reply.find((r) => r.name === this.topic);
      if (!streamReply) {
        continue;
      }
      for (const m of streamReply.messages) {
        if (this.aborted) {
          return;
        }
        yield this.toDelivered(m.id, m.message[PAYLOAD_FIELD] ?? "", group);
      }
    }
  }

  async close(): Promise<void> {
    this.closeController.abort();
  }

  private async *reclaim(group: string, consumer: string, count?: number): AsyncIterableIterator<DeliveredMessage> {
    let cursor = RECLAIM_CURSOR_START;
    while (!this.aborted) {
      const result = await this.client.xAutoClaim(
        this.topic,
        group,
        consumer,
        this.config.reclaimMinIdleMs,
        cursor,
        count !== undefined ? { COUNT: count } : undefined
      );
      const messages = result.messages ?? [];
      for (const m of messages) {
        // Entries deleted between scan and claim surface as null.
        if (m === null) {
          continue;
        }
        yield this.toDelivered(m.id, m.message[PAYLOAD_FIELD] ?? "", group);
      }
      // nextId === "0-0" signals the scan has completed.
      if (result.nextId === RECLAIM_CURSOR_START) {
        return;
      }
      cursor = result.nextId;
    }
  }

  private toDelivered(id: string, payload: string, group: string): DeliveredMessage {
    const ack = async (): Promise<void> => {
      await this.client.xAck(this.topic, group, id);
    };
    return { id, payload, ack };
  }
}
