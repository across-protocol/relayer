import { delay } from "@uma/financial-templates-lib";
import { SortableEvent } from "../interfaces";
import { Contract, Event, EventFilter, Promise } from "./";

const defaultConcurrency = 200;
const maxRetries = 3;
const retrySleepTime = 10;

export function spreadEvent(event: Event) {
  const keys = Object.keys(event.args).filter((key: string) => isNaN(+key)); // Extract non-numeric keys.

  let returnedObject: any = {};
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

export async function paginatedEventQuery(contract: Contract, filter: EventFilter, searchConfig: EventSearchConfig) {
  let retryCounter = 0;
  // If the max block look back is set to 0 then we dont need to do any pagination and can query over the whole range.
  if (searchConfig.maxBlockLookBack === 0)
    return await contract.queryFilter(filter, searchConfig.fromBlock, searchConfig.toBlock);

  // Compute the number of queries needed. If there is no maxBlockLookBack set then we can execute the whole query in
  // one go. Else, the number of queries is the range over which we are searching, divided by the maxBlockLookBack,
  // rounded up. This gives us the number of queries we need to execute to traverse the whole block range.
  let numberOfQueries = 1;
  if (!searchConfig.maxBlockLookBack) searchConfig.maxBlockLookBack = searchConfig.toBlock - searchConfig.fromBlock;
  else numberOfQueries = Math.ceil((searchConfig.toBlock - searchConfig.fromBlock) / searchConfig.maxBlockLookBack);
  const promises = [];
  for (let i = 0; i < numberOfQueries; i++) {
    const fromBlock = searchConfig.fromBlock + i * searchConfig.maxBlockLookBack;
    const toBlock = Math.min(searchConfig.fromBlock + (i + 1) * searchConfig.maxBlockLookBack, searchConfig.toBlock);
    promises.push(contract.queryFilter(filter, fromBlock, toBlock));
  }

  try {
    return (await Promise.all(promises, { concurrency: searchConfig.concurrency | defaultConcurrency })).flat(); // Default to 200 concurrent calls.
  } catch (error) {
    if (retryCounter++ < maxRetries) {
      await delay(retrySleepTime);
      return await paginatedEventQuery(contract, filter, searchConfig);
    } else throw error;
  }
}

export interface EventSearchConfig {
  fromBlock: number;
  toBlock: number | null;
  maxBlockLookBack: number;
  concurrency?: number | null;
}

export function spreadEventWithBlockNumber(event: Event): SortableEvent {
  return {
    ...spreadEvent(event),
    blockNumber: event.blockNumber,
    transactionIndex: event.transactionIndex,
    logIndex: event.logIndex,
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
