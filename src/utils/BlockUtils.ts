import { arch, interfaces, utils } from "@across-protocol/sdk";
import { isDefined, winston, type LatestBlockhash } from "./";
import {
  BlockFinderHints,
  EVMBlockFinder,
  isEVMSpokePoolClient,
  isSVMSpokePoolClient,
  SVMBlockFinder,
  chainIsEvm,
  SVMProvider,
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
export async function getBlockFinder(logger: winston.Logger, chainId: number): Promise<utils.BlockFinder<utils.Block>> {
  if (chainIsEvm(chainId)) {
    evmBlockFinders[chainId] ??= new EVMBlockFinder(await getProvider(chainId));
    return evmBlockFinders[chainId];
  }
  const provider = getSvmProvider(await getRedisCache());
  svmBlockFinder ??= new SVMBlockFinder(provider, [], logger);
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
  logger: winston.Logger,
  chainId: number,
  timestamp: number,
  blockFinder?: utils.BlockFinder<utils.Block>,
  redisCache?: interfaces.CachingMechanismInterface,
  hints: BlockFinderHints = {}
): Promise<number> {
  blockFinder ??= await getBlockFinder(logger, chainId);
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
        if (spokePoolClient === undefined || startBlock === undefined) {
          return;
        }

        // If a block range starts before a spoke pool's deployment block, use the deployment block timestamp.
        // This is a simplification we can make because we know that the results of this function, the start of bundle
        // timestamps, are compared against spoke pool client search config fromBlock timestamps. So if a fromBlock
        // is lower than a deployment block, than we know that all possible spoke pool clients can be found by the
        // spoke pool client. In other words, the spoke pool's deployment timestamp is the earliest timestamp we
        // should care about.
        const startAt = Math.max(spokePoolClient.deploymentBlock, startBlock);
        if (isEVMSpokePoolClient(spokePoolClient)) {
          return [chainId, (await spokePoolClient.spokePool.getCurrentTime({ blockTag: startAt })).toNumber()];
        } else if (isSVMSpokePoolClient(spokePoolClient)) {
          const provider = spokePoolClient.svmEventsClient.getRpc();
          const { timestamp } = await arch.svm.getNearestSlotTime(
            provider,
            {
              slot: BigInt(startAt),
            },
            spokePoolClient.logger
          );
          return [chainId, timestamp];
        }
      })
    ).filter(isDefined)
  );
}

export async function waitForNewSolanaBlock(provider: SVMProvider, _offset = 1): Promise<void> {
  const offset = BigInt(_offset);
  // Get the initial block height of the blockchain
  const { value: initialBlock } = (await provider.getLatestBlockhash().send()) as { value: LatestBlockhash };

  return new Promise((resolve) => {
    const SECOND = 1000;
    const checkInterval = 1 * SECOND; // Interval to check for new blocks (1000ms)

    // Set an interval to check for new block heights
    const intervalId = setInterval(async () => {
      // Get the current block height
      const { value: currentBlock } = (await provider.getLatestBlockhash().send()) as { value: LatestBlockhash };

      // If the current block height exceeds the target, resolve and clear interval
      if (currentBlock.lastValidBlockHeight >= initialBlock.lastValidBlockHeight + offset) {
        clearInterval(intervalId);
        resolve();
      }
    }, checkInterval);
  });
}
