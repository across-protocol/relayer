import { Block } from ".";
import { BlockFinder } from "@uma/financial-templates-lib";
import { createClient } from "redis4";

export type RedisClient = ReturnType<typeof createClient>;

// Avoid caching calls that are recent enough to be affected by things like reorgs.
// Current time must be >= 5 minutes past the event timestamp for it to be stable enough to cache.
export const REDIS_CACHEABLE_AGE = 300;

export async function setRedisKey(
  key: string,
  val: string,
  expirySeconds: number,
  redisClient: RedisClient
): Promise<void> {
  // EX: Expire key after expirySeconds.
  await redisClient.set(key, val, { EX: expirySeconds });
}

// Get the block number for a given timestamp fresh from on-chain data if not found in redis cache.
export async function getBlockForTimestamp(
  hubPoolChainId: number,
  chainId: number,
  timestamp: number,
  currentChainTime: number,
  blockFinder: BlockFinder<Block>,
  redisClient?: RedisClient
): Promise<number> {
  if (!redisClient) return (await blockFinder.getBlockForTimestamp(timestamp)).number;
  // We already cache blocks in the ConfigStore on the HubPool chain so re-use that key if the chainId
  // matches the HubPool's.
  const key = chainId === hubPoolChainId ? `block_number_${timestamp}` : `${chainId}_block_number_${timestamp}`;
  const result = await redisClient.get(key);
  if (result === null) {
    const blockNumber = (await blockFinder.getBlockForTimestamp(timestamp)).number;
    // Expire key after 90 days.
    if (shouldCache(timestamp, currentChainTime))
      await setRedisKey(key, blockNumber.toString(), 60 * 60 * 24 * 90, redisClient);
    return blockNumber;
  } else {
    return parseInt(result);
  }
}

export function shouldCache(eventTimestamp: number, latestTime: number): boolean {
  return latestTime - eventTimestamp >= REDIS_CACHEABLE_AGE;
}
