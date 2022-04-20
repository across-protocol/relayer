import { Contract, Event, EventFilter } from "./";

export function spreadEvent(event: Event) {
  const keys = Object.keys(event.args).filter((key: string) => isNaN(+key)); // Extract non-numeric keys.

  let returnedObject: any = {};
  keys.forEach((key: string) => (returnedObject[key] = event.args[key]));

  // ChainID information, if included in an event, should be cast to a number rather than a BigNumber.
  if (returnedObject.destinationChainId) returnedObject.destinationChainId = Number(returnedObject.destinationChainId);
  if (returnedObject.originChainId) returnedObject.originChainId = Number(returnedObject.originChainId);
  if (returnedObject.repaymentChainId) returnedObject.repaymentChainId = Number(returnedObject.repaymentChainId);

  return returnedObject;
}

export interface EventSearchConfig {
  fromBlock: number;
  toBlock: number;
  maxBlockLookBack: number;
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
