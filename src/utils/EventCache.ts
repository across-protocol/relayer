import { createClient } from "redis4";
import lodash from "lodash";
import {
  EventSearchConfig,
  EventFilter,
  Contract,
  eventKey,
  deepSerialize,
  deepDeserialize,
  spreadEventWithBlockNumber,
} from ".";
import { SortableEvent } from "../interfaces";
export type RedisClient = ReturnType<typeof createClient>;
export type Segments = [number, number][];
export type Config = {
  // key is a unique string provided by user, if you want to have different event filters for the same
  // name, you can keep those caches separate using a different key.
  key: string;
  // this is constructed with an event name to differentiate across event types in redis
  eventName: string;
  // chain id is required to separate chains
  chainId: number;
  redisClient: RedisClient;
  // you must construct this with a filter and contract, as this cannot change during the life of this cache.
  eventFilter: EventFilter;
  contract: Contract;
};
// This class acts a low level event cacher, and should work together with block paginator. It will
// cache blocks of event requests as they are found. It uses 2 data structures, one is the known segements
// the other is a serializable event. These get stored in redis at unique keys which are a combination of
// a user defined key, event name, chain id, and the data type (segment or event). This class only works for
// a single event type, single query parameters,  on a single chain, so multiple instantiations would typically be required.
export class EventCache {
  private segmentKey: string;
  private eventKey: string;
  // need to store local source of truth of known block ranges, to prevent concurrency issues when updating an array in redis.
  private segments: Segments | undefined;
  constructor(private readonly config: Config) {
    // Construct unique redis keys.
    this.segmentKey = ["segment", config.key, config.chainId, config.eventName].join("!");
    this.eventKey = ["event", config.key, config.chainId, config.eventName].join("!");
  }
  // merge overlapping segments. taken from https://stackoverflow.com/questions/32585990/algorithm-merge-overlapping-segments
  static mergeSegments(segments: Segments): Segments {
    if (segments.length === 0) return segments;
    const sorted = segments.sort((a, b) => {
      return a[0] - b[0];
    });

    const merged: [number, number][] = [sorted.shift()];

    sorted.forEach(([start, end]) => {
      const last = merged[merged.length - 1];
      // if the end of the last segment is more than 1 away than start of next segment, its not connected
      if (start - last[1] > 1) {
        merged.push([start, end]);
      } else {
        // because we have overlap set the last known segements end to the current segements end
        merged[merged.length - 1][1] = end;
      }
    });
    return merged;
  }
  // This takes an event, uses a special serializer to turn it into json safe for storign in redis
  static serializeEvent = (event: SortableEvent): string => {
    return [eventKey(event), deepSerialize(event)].join("!");
  };
  // take a string of of redis, rehydrate it to be a js object, basically just uses JSON.parse.
  static deserializeEvent = (event: string): SortableEvent => {
    const [, eventString] = event.split("!");
    return deepDeserialize<SortableEvent>(eventString);
  };
  // merges and stores known segments
  private async updateCachedSegments(fromBlock: number, toBlock: number): Promise<void> {
    const cachedSegments = await this.getLocalOrCachedSegments();
    await this.setCachedSegments(EventCache.mergeSegments([...cachedSegments, [fromBlock, toBlock]]));
  }
  // writes to redis and our local in memory representation of the segments array
  private async setCachedSegments(segments: Segments): Promise<void> {
    this.segments = segments;
    await this.config.redisClient.set(this.segmentKey, JSON.stringify(segments));
  }
  // gets known segments from redis.
  private async getCachedSegments(): Promise<Segments> {
    const data = (await this.config.redisClient.get(this.segmentKey)) || "[]";
    return JSON.parse(data) as Segments;
  }
  // use local memory or fallback to redis cache and store it locally
  async getLocalOrCachedSegments(): Promise<Segments> {
    if (this.segments) return this.segments;
    this.segments = await this.getCachedSegments();
    return this.segments;
  }
  // stores events in a sorted set in redis, this allows us to retrieve ranges in sorted order
  private async setCachedEvents(events: SortableEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.config.redisClient.zAdd(
      this.eventKey,
      events.map((event) => {
        return {
          // this score is 0 to allow for lexical sorting and querying on the value
          score: 0,
          value: EventCache.serializeEvent(event),
        };
      })
    );
  }
  // checks if the block range is within our known segments
  private async hasCachedEvents(fromBlock: number, toBlock: number): Promise<boolean> {
    const cachedSegments = await this.getLocalOrCachedSegments();
    const found = cachedSegments.find(([segmentStart, segmentEnd]) => {
      return fromBlock >= segmentStart && toBlock <= segmentEnd;
    });
    return found !== undefined;
  }
  // retrieves a range of events based on block numbers from redis. using a sorted set in redis so things should be returned in ascending order.
  // includeLastBlock is a toggle to allow you to be inclusive or exclusive to the last block, by default its inclusive.
  private async getCachedEvents(fromBlock: number, toBlock: number, includeLastBlock = true): Promise<SortableEvent[]> {
    const prefix = includeLastBlock ? "[" : "(";
    const search: [string, string] = [
      "[" + eventKey({ blockNumber: fromBlock, transactionIndex: 0, logIndex: 0 }),
      prefix + eventKey({ blockNumber: toBlock, transactionIndex: 0, logIndex: 0 }),
    ];
    // use scored entries and lexigraphic sort for event keys
    const data = (await this.config.redisClient.zRangeByLex(this.eventKey, ...search)) || [];
    return data.map(EventCache.deserializeEvent);
  }
  // This is the main entry point to start queries. It will either return cached events or query the blockchain
  // cache and return the events. Latestblocktocache can be used to prevent caching of blocks after that number.
  async queryFilter(fromBlock: number, toBlock: number, latestBlockToCache = 0): Promise<SortableEvent[]> {
    if (await this.hasCachedEvents(fromBlock, toBlock)) {
      return this.getCachedEvents(fromBlock, toBlock);
    }
    const events = await this.config.contract.queryFilter(this.config.eventFilter, fromBlock, toBlock);
    const sortableEvents = events.map(spreadEventWithBlockNumber);

    if (toBlock <= latestBlockToCache) {
      await Promise.all([this.setCachedEvents(sortableEvents), this.updateCachedSegments(fromBlock, toBlock)]);
    }
    return sortableEvents;
  }
}
