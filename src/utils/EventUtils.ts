import { Event } from "ethers";

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
