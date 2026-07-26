// In-memory RedisCacheInterface stand-in for tests. TTL honoured but
// otherwise no eviction; sufficient for InstanceCoordinator's get/set.

import { RedisCacheInterface } from "../../src/cache/Redis";

interface Entry {
  value: unknown;
  expiresAt?: number;
}

export class MemoryCache implements RedisCacheInterface {
  private readonly store = new Map<string, Entry>();

  async get<T>(key?: string): Promise<T | null> {
    if (key === undefined) {
      return null;
    }
    const entry = this.store.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<string | undefined> {
    this.store.set(key, {
      value,
      expiresAt: ttl !== undefined ? Date.now() + ttl * 1000 : undefined,
    });
    return "OK";
  }

  async decr(_key: string): Promise<number> {
    throw new Error("MemoryCache.decr not implemented");
  }
  async decrBy(_key: string, _amount: number): Promise<number> {
    throw new Error("MemoryCache.decrBy not implemented");
  }
  async incr(_key: string): Promise<number> {
    throw new Error("MemoryCache.incr not implemented");
  }
  async incrBy(_key: string, _amount: number): Promise<number> {
    throw new Error("MemoryCache.incrBy not implemented");
  }
}
