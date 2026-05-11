// In-memory MessageStream impl for unit tests. Single-consumer per (topic, group).
// Resubscribe redelivers unacked entries — stands in for the transport-specific
// "idle period" redelivery in the contract.

import {
  DeliveredMessage,
  MessageStream,
  PublishOptions,
  SubscribeOptions,
  Subscription,
} from "../../src/messaging/MessageStream";

interface Entry {
  id: string;
  payload: string;
}

interface GroupState {
  topic: string;
  // Position in entries array; entries[0..cursor) have been delivered to this group.
  cursor: number;
  // Indices into entries that are delivered but not yet acked.
  pending: Set<number>;
}

export class MemoryStream implements MessageStream {
  private readonly topics = new Map<string, Entry[]>();
  private readonly groups = new Map<string, GroupState>();
  private nextSeq = 1;

  async publish(topic: string, payload: string, _opts: PublishOptions = {}): Promise<string> {
    const id = `${this.nextSeq++}-0`;
    const entries = this.topics.get(topic) ?? [];
    entries.push({ id, payload });
    this.topics.set(topic, entries);
    return id;
  }

  async subscribe(topic: string, opts: SubscribeOptions): Promise<Subscription> {
    const groupKey = `${topic}::${opts.group}`;
    if (!this.groups.has(groupKey)) {
      // Mirrors XGROUP CREATE ... "$" — new groups skip existing entries.
      const entries = this.topics.get(topic) ?? [];
      this.groups.set(groupKey, { topic, cursor: entries.length, pending: new Set() });
    }
    return new MemorySubscription(this, topic, opts, groupKey);
  }

  async disconnect(): Promise<void> {
    this.topics.clear();
    this.groups.clear();
  }

  _entries(topic: string): Entry[] {
    return this.topics.get(topic) ?? [];
  }

  _group(key: string): GroupState | undefined {
    return this.groups.get(key);
  }

  _ack(groupKey: string, id: string): void {
    const state = this.groups.get(groupKey);
    if (state === undefined) return;
    const entries = this.topics.get(state.topic) ?? [];
    const idx = entries.findIndex((e) => e.id === id);
    if (idx >= 0) state.pending.delete(idx);
  }
}

class MemorySubscription implements Subscription {
  private readonly closeController = new AbortController();

  constructor(
    private readonly stream: MemoryStream,
    private readonly topic: string,
    private readonly opts: SubscribeOptions,
    private readonly groupKey: string
  ) {}

  async *messages(): AsyncIterableIterator<DeliveredMessage> {
    const state = this.stream._group(this.groupKey);
    if (state === undefined) return;

    // Redelivery: yield entries pending from prior subscriptions, in id order.
    const pendingSnapshot = [...state.pending].sort((a, b) => a - b);
    for (const idx of pendingSnapshot) {
      if (this.aborted) return;
      const entry = this.stream._entries(this.topic)[idx];
      if (entry !== undefined) yield this.toDelivered(entry);
    }

    // Live: yield new entries as they're published.
    const blockMs = this.opts.blockMs ?? 5;
    while (!this.aborted) {
      const entries = this.stream._entries(this.topic);
      while (!this.aborted && state.cursor < entries.length) {
        const idx = state.cursor++;
        state.pending.add(idx);
        yield this.toDelivered(entries[idx]);
      }
      if (this.aborted) return;
      await new Promise((r) => setTimeout(r, blockMs));
    }
  }

  async close(): Promise<void> {
    this.closeController.abort();
  }

  private get aborted(): boolean {
    return this.closeController.signal.aborted || (this.opts.signal?.aborted ?? false);
  }

  private toDelivered(entry: Entry): DeliveredMessage {
    return {
      id: entry.id,
      payload: entry.payload,
      ack: async () => {
        this.stream._ack(this.groupKey, entry.id);
      },
    };
  }
}
