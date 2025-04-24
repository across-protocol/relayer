import { utils as sdkUtils } from "@across-protocol/sdk";
import { isDefined, sortEventsAscending } from "../../utils";
import { Log, SpokePoolClientMessage } from "./../types";

/**
 * Given the inputs for a SpokePoolClient update, consolidate the inputs into a message and submit it to the parent
 * process (if defined).
 * @param blockNumber Block number up to which the update applies.
 * @param currentTime The SpokePool timestamp at blockNumber.
 * @param events An array of Log objects to be submitted.
 * @returns void
 */
export function postEvents(blockNumber: number, currentTime: number, events: Log[]): void {
  if (!isDefined(process.send)) {
    return;
  }

  const sortedEvents = sortEventsAscending(
    events.map(({ transactionHash, transactionIndex, ...event }) => ({
      ...event,
      txnRef: transactionHash,
      txnIndex: transactionIndex,
    }))
  );

  const message: SpokePoolClientMessage = {
    blockNumber,
    currentTime,
    nEvents: sortedEvents.length,
    data: JSON.stringify(sortedEvents, sdkUtils.jsonReplacerWithBigNumbers),
  };
  process.send(JSON.stringify(message));
}

/**
 * Given an event removal notification, post the message to the parent process.
 * @param event Log instance.
 * @returns void
 */
export function removeEvent(event: Log): void {
  if (!isDefined(process.send)) {
    return;
  }

  const message: SpokePoolClientMessage = {
    event: JSON.stringify(event, sdkUtils.jsonReplacerWithBigNumbers),
  };
  process.send(JSON.stringify(message));
}
