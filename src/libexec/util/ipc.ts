import { utils as sdkUtils } from "@across-protocol/sdk";
import { isDefined, sortEventsAscending } from "../../utils";
import { Log, ListenerMessage } from "./../types";

/**
 * Post a block update to the parent process (if defined).
 * @param blockNumber Block number up to which the update applies.
 * @param currentTime The SpokePool timestamp at blockNumber.
 * @returns True if message transmission succeeds, else false.
 */
export function postBlock(blockNumber: number, currentTime: number): boolean {
  if (!isDefined(process.send)) {
    // Process was probably started standalone.
    // https://nodejs.org/api/process.html#processsendmessage-sendhandle-options-callback
    return true;
  }

  const message: ListenerMessage = {
    blockNumber,
    currentTime,
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
    return;
  }

  try {
    process.send(message);
  } catch {
    return false;
  }

  return true;
}
