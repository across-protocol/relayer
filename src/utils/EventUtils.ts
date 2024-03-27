import { utils as sdkUtils } from "@across-protocol/sdk-v2";

export type EventSearchConfig = sdkUtils.EventSearchConfig;

export const {
  getPaginatedBlockRanges,
  getTransactionHashes,
  isEventOlder,
  paginatedEventQuery,
  sortEventsAscending,
  sortEventsAscendingInPlace,
  sortEventsDescending,
  sortEventsDescendingInPlace,
  spreadEvent,
  spreadEventWithBlockNumber,
} = sdkUtils;

/**
 * @notice Returns an array with the same length as the passed in Event array where each index is assigned a new index
 * that states its relative position to other events with the same transaction hash. If two or more of the input
 * events have the same transaction hash, they will be assigned unique indices starting at 0 and counting up based
 * on the order of events passed in.
 * @param events List of objects to pass in that contain a transaction hash.
 * @return Index for each event based on the # of other input events with the same transaction hash. The order of the
 * input events is preserved in the output array.
 */
export function getUniqueLogIndex(events: { transactionHash: string }[]): number[] {
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  for (const event of events) {
    const logIndex = uniqueTokenhashes[event.transactionHash] ?? 0;
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] = logIndex + 1;
  }
  return logIndexesForMessage;
}
