import { interfaces, utils } from "@across-protocol/sdk";
import { isDefined } from "./";
import { BlockFinder, BlockFinderHints } from "./SDKUtils";
import { getProvider } from "./ProviderUtils";
import { getRedisCache } from "./RedisUtils";
import { SpokePoolClientsByChain } from "../interfaces/SpokePool";

const blockFinders: { [chainId: number]: BlockFinder } = {};

/**
 * @notice Return block finder for chain. Loads from in memory blockFinder cache if this function was called before
 * for this chain ID. Otherwise creates a new block finder and adds it to the cache.
 * @param chainId
 * @returns
 */
export async function getBlockFinder(chainId: number): Promise<BlockFinder> {
  if (!isDefined(blockFinders[chainId])) {
    const providerForChain = await getProvider(chainId);
    blockFinders[chainId] = new BlockFinder(providerForChain);
  }
  return blockFinders[chainId];
}

/**
 * @notice Get the block number for a given timestamp fresh from on-chain data if not found in redis cache.
 * If redis cache is not available, then requests block from blockFinder.
 * @param chainId Chain to load block finder for.
 * @param timestamp Approximate timestamp of the to requested block number.
 * @param _blockFinder Caller can optionally pass in a block finder object to use instead of creating a new one
 * or loading from cache. This is useful for testing primarily.
 * @returns Block number for the requested timestamp.
 */
export async function getBlockForTimestamp(
  chainId: number,
  timestamp: number,
  blockFinder?: BlockFinder,
  redisCache?: interfaces.CachingMechanismInterface,
  hints: BlockFinderHints = {}
): Promise<number> {
  blockFinder ??= await getBlockFinder(chainId);
  redisCache ??= await getRedisCache();
  return utils.getCachedBlockForTimestamp(chainId, timestamp, blockFinder, redisCache, hints);
}

export async function getTimestampsForBundleEndBlocks(
  spokePoolClients: SpokePoolClientsByChain,
  blockRanges: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[]
): Promise<{ [chainId: number]: number }> {
  return Object.fromEntries(
    (
      await utils.mapAsync(blockRanges, async ([, endBlock], index) => {
        const chainId = chainIdListForBundleEvaluationBlockNumbers[index];
        const spokePoolClient = spokePoolClients[chainId];
        if (spokePoolClient === undefined) {
          return;
        }
        return [chainId, (await spokePoolClient.spokePool.getCurrentTime({ blockTag: endBlock })).toNumber()];
      })
    ).filter(isDefined)
  );
}
