// Propose and validate `numberOfBundles` bundles, each with random size block ranges. The block range size

import { SpokePoolClientsByChain } from "../../src/interfaces";
import { BigNumber, createRandomBytes32, toBN } from "../constants";
import { MockHubPoolClient } from "../mocks/MockHubPoolClient";

// Propose and validate `numberOfBundles` bundles, each with random size block ranges. The block range size
// can be hardcoded by providing a `randomJumpOverride` parameter.
export async function publishValidatedBundles(
  chainIds: number[],
  l1Tokens: string[],
  hubPoolClient: MockHubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  numberOfBundles: number,
  _runningBalances?: BigNumber[],
  _incentiveBalances?: BigNumber[]
): Promise<Record<number, { start: number; end: number }[]>> {
  // Create a sets of unique block ranges per chain so that we have a lower chance of false positives
  // when fetching the block ranges for a specific chain.
  const expectedBlockRanges: Record<number, { start: number; end: number }[]> = {}; // Save expected ranges here
  let nextBlockRangesForChain = Object.fromEntries(
    chainIds.map((chainId) => {
      // Random block range between 25 and 50 blocks.
      const randomJump = 25 + Math.floor(Math.random() * 25);
      const _blockRange = [chainId, { start: 0, end: randomJump }];
      return _blockRange;
    })
  );

  const runningBalances = _runningBalances ?? chainIds.map(() => toBN(0));
  const incentiveBalances = _incentiveBalances ?? chainIds.map(() => toBN(0));
  for (let i = 0; i < numberOfBundles; i++) {
    const bundleEvaluationBlockNumbers = chainIds.map((chainId) => {
      if (!expectedBlockRanges[chainId]) {
        expectedBlockRanges[chainId] = [];
      }
      return toBN(nextBlockRangesForChain[chainId].end);
    });

    const rootBundleProposal = hubPoolClient.proposeRootBundle(
      Date.now(), // challengePeriodEndTimestamp
      chainIds.length, // poolRebalanceLeafCount
      bundleEvaluationBlockNumbers,
      createRandomBytes32() // Random pool rebalance root we can check.
    );
    hubPoolClient.addEvent(rootBundleProposal);
    await hubPoolClient.update();
    chainIds.forEach((chainId) => {
      expectedBlockRanges[chainId].push({
        ...nextBlockRangesForChain[chainId],
      });
    });
    chainIds.forEach((chainId, leafIndex) => {
      const leafEvent = hubPoolClient.executeRootBundle(
        toBN(0),
        leafIndex,
        toBN(chainId),
        l1Tokens, // l1Tokens
        runningBalances, // bundleLpFees
        runningBalances, // netSendAmounts
        runningBalances.concat(incentiveBalances) // runningBalances
      );
      hubPoolClient.addEvent(leafEvent);
    });

    await hubPoolClient.update();

    // Make next block range span a random number of blocks:
    const nextBlockRangeSize = 25 + Math.ceil(Math.random() * 25);
    nextBlockRangesForChain = Object.fromEntries(
      chainIds.map((chainId) => [
        chainId,
        {
          start: nextBlockRangesForChain[chainId].end + 1,
          end: nextBlockRangesForChain[chainId].end + 1 + nextBlockRangeSize,
        },
      ])
    );
  }
  await Promise.all(chainIds.map((chainId) => spokePoolClients[Number(chainId)].update()));

  // Iterate over all the expected block ranges. Our goal is to ensure that none of the
  // block ranges are invalid for the case of testing purposes. If we find a `start` block
  // that is equal to or greater than the `end` block, we will set the `end` block to be
  // equal to the `start` block + 1.
  Object.values(expectedBlockRanges).forEach((blockRanges) => {
    blockRanges.forEach((blockRange) => {
      if (blockRange.start >= blockRange.end) {
        blockRange.end = blockRange.start + 1;
      }
    });
  });

  // Make the last bundle to cover until the last spoke client searched block, unless a spoke pool
  // client was provided for the chain. In this case we assume that chain is disabled.
  chainIds.forEach((chainId) => {
    expectedBlockRanges[chainId][expectedBlockRanges[chainId].length - 1].end =
      spokePoolClients[chainId].latestBlockSearched;
  });
  return expectedBlockRanges;
}
