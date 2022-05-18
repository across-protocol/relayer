export function getBlockRangeForChain(
  blockRange: number[][],
  chain: number,
  chainIdListForBundleEvaluationBlockNumbers: number[]
): number[] {
  const indexForChain = chainIdListForBundleEvaluationBlockNumbers.indexOf(chain);
  if (indexForChain === -1)
    throw new Error(
      `Could not find chain ${chain} in chain ID list ${this.chainIdListForBundleEvaluationBlockNumbers}`
    );
  const blockRangeForChain = blockRange[indexForChain];
  if (!blockRangeForChain || blockRangeForChain.length !== 2) throw new Error(`Invalid block range for chain ${chain}`);
  return blockRangeForChain;
}
