import { interfaces, utils } from "@across-protocol/sdk";
import { isDefined } from "./";
import {
  BlockFinderHints,
  EVMBlockFinder,
  isEVMSpokePoolClient,
  isSVMSpokePoolClient,
  SVMBlockFinder,
  chainIsEvm,
} from "./SDKUtils";
import { getProvider, getSvmProvider } from "./ProviderUtils";
import { getRedisCache } from "./RedisUtils";
import { SpokePoolClientsByChain } from "../interfaces/SpokePool";

const evmBlockFinders: { [chainId: number]: EVMBlockFinder } = {};
let svmBlockFinder: SVMBlockFinder;

/**
 * @notice Return block finder for chain. Loads from in memory blockFinder cache if this function was called before
 * for this chain ID. Otherwise creates a new block finder and adds it to the cache.
 * @param chainId
 * @returns
 */
export async function getBlockFinder(chainId: number): Promise<utils.BlockFinder<utils.Block>> {
  if (chainIsEvm(chainId)) {
    evmBlockFinders[chainId] ??= new EVMBlockFinder(await getProvider(chainId));
    return evmBlockFinders[chainId];
  }
  const provider = getSvmProvider();
  svmBlockFinder ??= new SVMBlockFinder(provider);
  return svmBlockFinder;
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
  blockFinder?: utils.BlockFinder<utils.Block>,
  redisCache?: interfaces.CachingMechanismInterface,
  hints: BlockFinderHints = {}
): Promise<number> {
  blockFinder ??= await getBlockFinder(chainId);
  redisCache ??= await getRedisCache();
  return utils.getCachedBlockForTimestamp(chainId, timestamp, blockFinder, redisCache, hints);
}

export async function getTimestampsForBundleStartBlocks(
  spokePoolClients: SpokePoolClientsByChain,
  blockRanges: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[]
): Promise<{ [chainId: number]: number }> {
  return Object.fromEntries(
    (
      await utils.mapAsync(blockRanges, async ([startBlock], index) => {
        const chainId = chainIdListForBundleEvaluationBlockNumbers[index];
        const spokePoolClient = spokePoolClients[chainId];
        if (spokePoolClient === undefined) {
          return;
        }
        // If a block range starts before a spoke pool's deployment block, use the deployment block timestamp.
        // This is a simplification we can make because we know that the results of this function, the start of bundle
        // timestamps, are compared against spoke pool client search config fromBlock timestamps. So if a fromBlock
        // is lower than a deployment block, than we know that all possible spoke pool clients can be found by the
        // spoke pool client. In other words, the spoke pool's deployment timestamp is the earliest timestamp we
        // should care about.
        const startBlockToQuery = Math.max(spokePoolClient.deploymentBlock, startBlock);
        if (isEVMSpokePoolClient(spokePoolClient)) {
          return [
            chainId,
            (await spokePoolClient.spokePool.getCurrentTime({ blockTag: startBlockToQuery })).toNumber(),
          ];
        } else if (isSVMSpokePoolClient(spokePoolClient)) {
          return [
            chainId,
            Number(await spokePoolClient.svmEventsClient.getRpc().getBlockTime(BigInt(startBlockToQuery)).send()),
          ];
        }
      })
    ).filter(isDefined)
  );
}
