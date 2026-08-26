import { utils as sdkUtils } from "@across-protocol/sdk";
import { isDefined, sortEventsAscending } from "../../utils";
import { Log, ListenerMessage } from "./../types";

/**
 * Post a block update to the parent process (if defined).
 * @param blockNumber Block number up to which the update applies.
 * @param currentTime The SpokePool timestamp at blockNumber.
 * @param observedAt When the block was pushed to the listener by a live subscription. Omit it when the block was
 * discovered by polling: the interval then measures poll phase rather than how late the block was published.
 * @returns True if message transmission succeeds, else false.
 */
export function postBlock(blockNumber: number, currentTime: number, observedAt?: number): boolean {
  if (!isDefined(process.send)) {
    // Process was probably started standalone.
    // https://nodejs.org/api/process.html#processsendmessage-sendhandle-options-callback
    return true;
  }

  const message: ListenerMessage = {
    blockNumber,
    currentTime,
    observedAt,
  };

  return post(message);
}

/**
 * Post an array of events to the parent process (if defined).
 * @param events An array of Log objects to be submitted.
 * @returns True if message transmission succeeds, else false.
 */
export function postEvents(events: Log[]): boolean {
  if (!isDefined(process.send)) {
    // Process was probably started standalone.
    // https://nodejs.org/api/process.html#processsendmessage-sendhandle-options-callback
    return true;
  }

  events = sortEventsAscending(events);
  const message: ListenerMessage = {
    nEvents: events.length,
    data: JSON.stringify(events, sdkUtils.jsonReplacerWithBigNumbers),
  };

  return post(message);
}

/**
 * Given an event removal notification, post the message to the parent process.
 * @param event Log instance.
 * @returns void
 */
export function removeEvent(event: Log): boolean {
  const message: ListenerMessage = {
    event: JSON.stringify(event, sdkUtils.jsonReplacerWithBigNumbers),
  };

  return post(message);
}

function post(message: ListenerMessage): boolean {
  if (!isDefined(process.send)) {
    return true;
  }

  // process.send() does not throw on a closed channel; it returns false and emits
  // an async 'error' event on `process`. Skip the call entirely once disconnected.
  if (!process.connected) {
    return false;
  }

  // Discard process.send()'s return value: per node docs it is also false under
  // IPC backlog pressure, and treating backpressure as a hard failure would
  // spuriously abort the listener. Disconnects are caught by process.connected.
  process.send(JSON.stringify(message));
  return true;
}
