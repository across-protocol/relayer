import { utils as sdkUtils } from "@across-protocol/sdk";
import { isDefined, sortEventsAscending } from "../../utils";
import { Log, SpokePoolClientMessage } from "./../types";

export function postBlock(blockNumber: number, currentTime: number): boolean {
  if (!isDefined(process.send)) {
    // Process was probably started standalone.
    // https://nodejs.org/api/process.html#processsendmessage-sendhandle-options-callback
    return true;
  }

  const message: SpokePoolClientMessage = {
    blockNumber,
    currentTime,
  };

  const msg = JSON.stringify(message);
  try {
    process.send(msg);
  } catch {
    return false;
  }

  return true;
}

export function postEvents(events: Log[]): boolean {
  if (!isDefined(process.send)) {
    // Process was probably started standalone.
    // https://nodejs.org/api/process.html#processsendmessage-sendhandle-options-callback
    return true;
  }

  events = sortEventsAscending(events);
  const message: SpokePoolClientMessage = {
    nEvents: events.length,
    data: JSON.stringify(events, sdkUtils.jsonReplacerWithBigNumbers),
  };

  const msg = JSON.stringify(message);
  try {
    process.send(msg);
  } catch {
    return false;
  }

  return true;
}

/**
 * Given an event removal notification, post the message to the parent process.
 * @param event Log instance.
 * @returns void
 */
export function removeEvent(event: Log): boolean {
  const message: SpokePoolClientMessage = {
    event: JSON.stringify(event, sdkUtils.jsonReplacerWithBigNumbers),
  };
  return post(message);
}

function post(message: SpokePoolClientMessage): boolean {
  if (!isDefined(process.send)) {
    return;
  }

  try {
    process.send(message);
    return true;
  } catch {
    return false;
  }
}
