import { Event } from "ethers";
import { SortableEvent } from "../interfaces";

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

  return returnedObject;
}

export function spreadEventWithBlockNumber(event: Event): SortableEvent {
  return {
    ...spreadEvent(event),
    blockNumber: event.blockNumber,
    transactionIndex: event.transactionIndex,
    logIndex: event.logIndex,
  };
}

export function sortEventsAscending(events: SortableEvent[]): SortableEvent[] {
  return [...events].sort((ex, ey) => {
    if (ex.blockNumber !== ey.blockNumber) return ex.blockNumber - ey.blockNumber;
    if (ex.transactionIndex !== ey.transactionIndex) return ex.transactionIndex - ey.transactionIndex;
    return ex.logIndex - ey.logIndex;
  });
}

export function sortEventsDescending(events: SortableEvent[]): SortableEvent[] {
  return [...events].sort((ex, ey) => {
    if (ex.blockNumber !== ey.blockNumber) return ey.blockNumber - ex.blockNumber;
    if (ex.transactionIndex !== ey.transactionIndex) return ey.transactionIndex - ex.transactionIndex;
    return ey.logIndex - ex.logIndex;
  });
}
