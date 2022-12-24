import { Block } from ".";
import { BlockFinder } from "@uma/financial-templates-lib";
import { createClient } from "redis4";

export type RedisClient = ReturnType<typeof createClient>;

// Avoid caching calls that are recent enough to be affected by things like reorgs.
// Current time must be >= 5 minutes past the event timestamp for it to be stable enough to cache.
export const REDIS_CACHEABLE_AGE = 300;

// Get the block number for a given timestamp fresh from on-chain data if not found in redis cache.
export async function getBlockForTimestamp(
  chainId: number,
  timestamp: number,
  currentChainTime: number,
  blockFinder: BlockFinder<Block>,
  redisClient?: RedisClient
): Promise<number> {
  if (!redisClient) return (await blockFinder.getBlockForTimestamp(timestamp)).number;
  const key = chainId === 1 ? `block_number_${timestamp}` : `${chainId}_block_number_${timestamp}`;
  const result = await redisClient.get(key);
  if (result === null) {
    const blockNumber = (await blockFinder.getBlockForTimestamp(timestamp)).number;
    if (shouldCache(timestamp, currentChainTime)) await redisClient.set(key, blockNumber.toString());
    return blockNumber;
  } else {
    return parseInt(result);
  }
}

export function shouldCache(eventTimestamp: number, latestTime: number): boolean {
  return latestTime - eventTimestamp >= REDIS_CACHEABLE_AGE;
}
