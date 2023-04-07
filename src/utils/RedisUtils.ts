import { assert, Block, getProvider, toBN } from ".";
import { REDIS_URL_DEFAULT } from "../common/Constants";
import { BlockFinder } from "@uma/financial-templates-lib";
import { createClient } from "redis4";
import winston from "winston";
import { Deposit, Fill } from "../interfaces";
import dotenv from "dotenv";
import { BigNumberish } from "@across-protocol/sdk-v2/dist/utils";
dotenv.config();

export type RedisClient = ReturnType<typeof createClient>;

// Avoid caching calls that are recent enough to be affected by things like reorgs.
// Current time must be >= 15 minutes past the event timestamp for it to be stable enough to cache.
export const REDIS_CACHEABLE_AGE = 15 * 60;

export const REDIS_URL = process.env.REDIS_URL || REDIS_URL_DEFAULT;

// Make the redis client for a particular url essentially a singleton.
const redisClients: { [url: string]: RedisClient } = {};

const blockFinders: { [chainId: number]: BlockFinder<Block> } = {};

export async function getRedis(logger?: winston.Logger, url = REDIS_URL): Promise<RedisClient | undefined> {
  if (!redisClients[url]) {
    try {
      const redisClient = createClient({ url });
      await redisClient.connect();
      if (logger)
        logger.debug({
          at: "Dataworker#ClientHelper",
          message: `Connected to redis server at ${url} successfully!`,
          dbSize: await redisClient.dbSize(),
        });
      redisClients[url] = redisClient;
    } catch (err) {
      if (logger)
        logger.debug({
          at: "Dataworker#ClientHelper",
          message: `Failed to connec to redis server at ${url}.`,
        });
    }
  }

  return redisClients[url];
}

export async function setRedisKey(
  key: string,
  val: string,
  redisClient: RedisClient,
  expirySeconds = 0
): Promise<void> {
  if (expirySeconds > 0) {
    // EX: Expire key after expirySeconds.
    await redisClient.set(key, val, { EX: expirySeconds });
  } else await redisClient.set(key, val);
}

export function getRedisDepositKey(depositOrFill: Deposit | Fill): string {
  return `deposit_${depositOrFill.originChainId}_${depositOrFill.depositId}`;
}

export async function setDeposit(
  deposit: Deposit,
  currentChainTime: number,
  redisClient: RedisClient,
  expirySeconds = 0
): Promise<void> {
  if (shouldCache(deposit.quoteTimestamp, currentChainTime))
    await setRedisKey(getRedisDepositKey(deposit), JSON.stringify(deposit), redisClient, expirySeconds);
}

export async function getDeposit(key: string, redisClient: RedisClient): Promise<Deposit | undefined> {
  const depositRaw = await redisClient.get(key);
  if (depositRaw) return JSON.parse(depositRaw, objectWithBigNumberReviver);
}

/**
 * @notice Return block finder for chain. Loads from in memory blockFinder cache if this function was called before
 * for this chain ID. Otherwise creates a new block finder and adds it to the cache.
 * @param chainId
 * @returns
 */
async function getBlockFinder(chainId: number): Promise<BlockFinder<Block>> {
  if (!blockFinders[chainId]) {
    const providerForChain = await getProvider(chainId);
    blockFinders[chainId] = new BlockFinder<Block>(providerForChain.getBlock.bind(providerForChain), [], chainId);
  }
  return blockFinders[chainId];
}

/**
 * @notice Get the block number for a given timestamp fresh from on-chain data if not found in redis cache.
 * If redis cache is not available, then requests block from blockFinder.
 * @param chainId Chain to load block finder for.
 * @param blockFinder Caller can optionally pass in a block finder object to use instead of creating a new one
 * or loading from cache. This is useful for testing primarily.
 * @returns
 */
export async function getBlockForTimestamp(
  hubPoolChainId: number,
  chainId: number,
  timestamp: number,
  currentChainTime: number,
  blockFinder?: BlockFinder<Block>
): Promise<number> {
  if (blockFinder === undefined) blockFinder = await getBlockFinder(chainId);
  const redisClient = await getRedis();

  // If no redis client, then request block from blockFinder. Otherwise try to load from redis cache.
  if (redisClient === undefined) return (await blockFinder.getBlockForTimestamp(timestamp)).number;
  // We already cache blocks in the ConfigStore on the HubPool chain so re-use that key if the chainId
  // matches the HubPool's.
  const key = chainId === hubPoolChainId ? `block_number_${timestamp}` : `${chainId}_block_number_${timestamp}`;
  const result = await redisClient.get(key);
  if (result === null) {
    const blockNumber = (await blockFinder.getBlockForTimestamp(timestamp)).number;
    // Expire key after 90 days.
    if (shouldCache(timestamp, currentChainTime))
      await setRedisKey(key, blockNumber.toString(), redisClient, 60 * 60 * 24 * 90);
    return blockNumber;
  } else {
    return parseInt(result);
  }
}

export async function disconnectRedisClient(logger?: winston.Logger): Promise<void> {
  const redisClient = await getRedis(logger);
  if (redisClient !== undefined) {
    // todo understand why redisClient isn't GCed automagically.
    logger.debug("Disconnecting from redis server.");
    redisClient.disconnect();
  }
}

export function shouldCache(eventTimestamp: number, latestTime: number): boolean {
  assert(eventTimestamp.toString().length === 10, "eventTimestamp must be in seconds");
  assert(latestTime.toString().length === 10, "eventTimestamp must be in seconds");
  return latestTime - eventTimestamp >= REDIS_CACHEABLE_AGE;
}

// JSON.stringify(object) ends up stringfying BigNumber objects as "{type:BigNumber,hex...}" so we can pass
// this reviver function as the second arg to JSON.parse to instruct it to correctly revive a stringified
// object with BigNumber values.
function objectWithBigNumberReviver(_: string, value: { type: string; hex: BigNumberish }) {
  if (typeof value !== "object" || value?.type !== "BigNumber") return value;
  return toBN(value.hex);
}
