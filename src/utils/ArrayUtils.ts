import { SortableEvent } from "../interfaces";
import lodash from "lodash";

export function sliceBlockRangeSorted<T extends SortableEvent>(
  sortedArray: T[],
  startBlock: number,
  endBlock: number
): T[] {
  const startIndex = lodash.findIndex(sortedArray, (event) => event.blockNumber >= startBlock);
  if (startIndex === -1) return [];
  const endIndex = lodash.findIndex(sortedArray, (event) => event.blockNumber > endBlock);

  // Is slice faster than just grabbing the elements until the end at the same time as computing the endIndex in the
  // above step?
  return sortedArray.slice(startIndex, endIndex < 0 ? undefined : endIndex);
}
