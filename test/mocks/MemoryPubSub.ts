// In-memory RedisPubSub stand-in for tests. Same surface as RedisPubSub:
// pub/sub/unsub/disconnect. Listeners are invoked synchronously from pub().

import { interfaces } from "@across-protocol/sdk";

type Listener = (message: string, channel: string) => void;

export class MemoryPubSub implements interfaces.PubSubMechanismInterface {
  private readonly channels = new Map<string, Set<Listener>>();
  private closed = false;

  async pub(channel: string, message: string): Promise<number> {
    if (this.closed) {
      throw new Error("MemoryPubSub is closed");
    }
    const listeners = this.channels.get(channel);
    if (listeners === undefined) {
      return 0;
    }
    for (const listener of [...listeners]) {
      listener(message, channel);
    }
    return listeners.size;
  }

  async sub(channel: string, listener: Listener): Promise<void> {
    if (this.closed) {
      throw new Error("MemoryPubSub is closed");
    }
    let listeners = this.channels.get(channel);
    if (listeners === undefined) {
      listeners = new Set();
      this.channels.set(channel, listeners);
    }
    listeners.add(listener);
  }

  async unsub(channel: string, listener: Listener): Promise<void> {
    const listeners = this.channels.get(channel);
    if (listeners === undefined) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      this.channels.delete(channel);
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.channels.clear();
  }
}
