import { Contract, Event, EventFilter } from "./";

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

  return returnedObject;
}

export async function paginatedEventQuery(contract: Contract, filter: EventFilter, searchConfig: EventSearchConfig) {
  // If the max block look back is set to 0 then we dont need to do any pagination and can query over the whole range.
  if (searchConfig.maxBlockLookBack === 0)
    return await contract.queryFilter(filter, searchConfig.fromBlock, searchConfig.toBlock);

  // The number of queries is the range over which we are searching, divided by the maxBlockLookBack, rounded up.
  const numberOfQueries = Math.ceil((searchConfig.toBlock - searchConfig.fromBlock) / searchConfig.maxBlockLookBack);

  let promises = [];
  for (let i = 0; i < numberOfQueries; i++) {
    const fromBlock = searchConfig.fromBlock + i * searchConfig.maxBlockLookBack;
    const toBlock = Math.min(searchConfig.fromBlock + (i + 1) * searchConfig.maxBlockLookBack, searchConfig.toBlock);
    promises.push(contract.queryFilter(filter, fromBlock, toBlock));
  }

  return (await Promise.all(promises)).flat();
}

export interface EventSearchConfig {
  fromBlock: number;
  toBlock: number | null;
  maxBlockLookBack: number;
}
export function spreadEventWithBlockNumber(event: Event) {
  return {
    ...spreadEvent(event),
    blockNumber: event.blockNumber,
  };
}

export function sortEventsAscending(events: { blockNumber: number }[]): { blockNumber: number }[] {
  return [...events].sort((ex, ey) => ex.blockNumber - ey.blockNumber);
}

export function sortEventsDescending(events: { blockNumber: number }[]): { blockNumber: number }[] {
  return [...events].sort((ex, ey) => ey.blockNumber - ex.blockNumber);
}
