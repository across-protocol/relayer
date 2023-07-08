import { BlockFinder } from "@uma/financial-templates-lib";
import { Block, getProvider, getRedis, isDefined, setRedisKey, shouldCache } from "./";

const blockFinders: { [chainId: number]: BlockFinder<Block> } = {};

/**
 * @notice Return block finder for chain. Loads from in memory blockFinder cache if this function was called before
 * for this chain ID. Otherwise creates a new block finder and adds it to the cache.
 * @param chainId
 * @returns
 */
export async function getBlockFinder(chainId: number): Promise<BlockFinder<Block>> {
  if (!isDefined(blockFinders[chainId])) {
    const providerForChain = await getProvider(chainId);
    blockFinders[chainId] = new BlockFinder<Block>(providerForChain.getBlock.bind(providerForChain), [], chainId);
  }
  return blockFinders[chainId];
}

/**
 * @notice Get the block number for a given timestamp fresh from on-chain data if not found in redis cache.
 * If redis cache is not available, then requests block from blockFinder.
 * @param chainId Chain to load block finder for.
 * @param timestamp Approximate timestamp of the to requested block number.
 * @param blockFinder Caller can optionally pass in a block finder object to use instead of creating a new one
 * or loading from cache. This is useful for testing primarily.
 * @returns Block number for the requested timestamp.
 */
export async function getBlockForTimestamp(
  chainId: number,
  timestamp: number,
  blockFinder?: BlockFinder<Block>
): Promise<number> {
  blockFinder ??= await getBlockFinder(chainId);
  const redisClient = await getRedis();

  // If no redis client, then request block from blockFinder. Otherwise try to load from redis cache.
  if (redisClient === undefined) {
    return (await blockFinder.getBlockForTimestamp(timestamp)).number;
  }

  const key = `${chainId}_block_number_${timestamp}`;
  const result = await redisClient.get(key);
  if (result === null) {
    const provider = await getProvider(chainId);
    const [currentBlock, { number: blockNumber }] = await Promise.all([
      provider.getBlock("latest"),
      blockFinder.getBlockForTimestamp(timestamp),
    ]);

    // Expire key after 90 days.
    if (shouldCache(timestamp, currentBlock.timestamp)) {
      await setRedisKey(key, blockNumber.toString(), redisClient, 60 * 60 * 24 * 90);
    }
    return blockNumber;
  } else {
    return parseInt(result);
  }
}
