import { delay } from "@uma/financial-templates-lib";
import { DepositWithBlock, FillWithBlock, SortableEvent } from "../interfaces";
import { Contract, Event, EventFilter, Promise } from "./";

const defaultConcurrency = 200;
const maxRetries = 3;
const retrySleepTime = 10;

export function spreadEvent(event: Event) {
  const keys = Object.keys(event.args).filter((key: string) => isNaN(+key)); // Extract non-numeric keys.

  const returnedObject: any = {};
  keys.forEach((key: string) => (returnedObject[key] = event.args[key]));

  // ID information, if included in an event, should be cast to a number rather than a BigNumber.
  if (returnedObject.groupIndex) returnedObject.groupIndex = Number(returnedObject.groupIndex);
  if (returnedObject.leafId) returnedObject.leafId = Number(returnedObject.leafId);
  if (returnedObject.chainId) returnedObject.chainId = Number(returnedObject.chainId);
  if (returnedObject.destinationChainId) returnedObject.destinationChainId = Number(returnedObject.destinationChainId);
  if (returnedObject.originChainId) returnedObject.originChainId = Number(returnedObject.originChainId);
  if (returnedObject.repaymentChainId) returnedObject.repaymentChainId = Number(returnedObject.repaymentChainId);
  if (returnedObject.l2ChainId) returnedObject.l2ChainId = Number(returnedObject.l2ChainId);
  if (returnedObject.rootBundleId) returnedObject.rootBundleId = Number(returnedObject.rootBundleId);

  return returnedObject;
}

export interface EventSearchConfig {
  fromBlock: number;
  toBlock: number | null;
  maxBlockLookBack?: number;
  concurrency?: number | null;
}

export async function paginatedEventQuery(
  contract: Contract,
  filter: EventFilter,
  searchConfig: EventSearchConfig,
  retryCount = 0
) {
  // If the max block look back is set to 0 then we dont need to do any pagination and can query over the whole range.
  if (searchConfig.maxBlockLookBack === 0)
    return await contract.queryFilter(filter, searchConfig.fromBlock, searchConfig.toBlock);

  // Compute the number of queries needed. If there is no maxBlockLookBack set then we can execute the whole query in
  // one go. Else, the number of queries is the range over which we are searching, divided by the maxBlockLookBack,
  // rounded up. This gives us the number of queries we need to execute to traverse the whole block range.
  const paginatedRanges = getPaginatedBlockRanges(searchConfig);

  try {
    return (
      await Promise.map(
        paginatedRanges,
        async ([fromBlock, toBlock]) => {
          return contract.queryFilter(filter, fromBlock, toBlock);
        },
        { concurrency: searchConfig.concurrency | defaultConcurrency }
      )
    ).flat();
  } catch (error) {
    if (retryCount < maxRetries) {
      await delay(retrySleepTime);
      return await paginatedEventQuery(contract, filter, searchConfig, retryCount+1);
    } else throw error;
  }
}

export function getPaginatedBlockRanges(searchConfig: EventSearchConfig): number[][] {
  const nextSearchConfig = { fromBlock: searchConfig.fromBlock, toBlock: searchConfig.toBlock };

  if (searchConfig.maxBlockLookBack !== undefined)
    nextSearchConfig.toBlock = Math.min(searchConfig.toBlock, searchConfig.fromBlock + searchConfig.maxBlockLookBack);

  if (searchConfig.maxBlockLookBack === 0) throw new Error("Cannot set maxBlockLookBack = 0");

  const returnValue: number[][] = [];
  while (nextSearchConfig.fromBlock <= searchConfig.toBlock) {
    returnValue.push([nextSearchConfig.fromBlock, nextSearchConfig.toBlock]);
    nextSearchConfig.fromBlock = nextSearchConfig.toBlock + 1;
    if (searchConfig.maxBlockLookBack !== undefined)
      nextSearchConfig.toBlock = Math.min(
        searchConfig.toBlock,
        nextSearchConfig.fromBlock + searchConfig.maxBlockLookBack
      );
  }
  return returnValue;
}

export function spreadEventWithBlockNumber(event: Event): SortableEvent {
  return {
    ...spreadEvent(event),
    blockNumber: event.blockNumber,
    transactionIndex: event.transactionIndex,
    logIndex: event.logIndex,
    transactionHash: event.transactionHash,
  };
}

export function sortEventsAscending<T extends SortableEvent>(events: T[]): T[] {
  return [...events].sort((ex, ey) => {
    if (ex.blockNumber !== ey.blockNumber) return ex.blockNumber - ey.blockNumber;
    if (ex.transactionIndex !== ey.transactionIndex) return ex.transactionIndex - ey.transactionIndex;
    return ex.logIndex - ey.logIndex;
  });
}

export function sortEventsDescending<T extends SortableEvent>(events: T[]): T[] {
  return [...events].sort((ex, ey) => {
    if (ex.blockNumber !== ey.blockNumber) return ey.blockNumber - ex.blockNumber;
    if (ex.transactionIndex !== ey.transactionIndex) return ey.transactionIndex - ex.transactionIndex;
    return ey.logIndex - ex.logIndex;
  });
}

export function getTransactionHashes(events: SortableEvent[]) {
  return [...new Set(events.map((e) => e.transactionHash))];
}
