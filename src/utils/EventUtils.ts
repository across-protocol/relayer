import assert from "assert";
import winston from "winston";
import { utils as ethersUtils } from "ethers";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { Log } from "../interfaces";
import { getNetworkName } from "./NetworkUtils";
import { dedupArray } from "./SDKUtils";
import { isDefined } from "./TypeGuards";

export type EventSearchConfig = sdkUtils.EventSearchConfig;

export const {
  getPaginatedBlockRanges,
  getTransactionRefs,
  isEventOlder,
  paginatedEventQuery,
  sortEventsAscending,
  sortEventsAscendingInPlace,
  sortEventsDescending,
  sortEventsDescendingInPlace,
  spreadEvent,
  spreadEventWithBlockNumber,
} = sdkUtils;

/**
 * @notice Returns an array with the same length as the passed in Event array where each index is assigned a new index
 * that states its relative position to other events with the same transaction hash. If two or more of the input
 * events have the same transaction hash, they will be assigned unique indices starting at 0 and counting up based
 * on the order of events passed in.
 * @param events List of objects to pass in that contain a transaction hash.
 * @return Index for each event based on the # of other input events with the same transaction hash. The order of the
 * input events is preserved in the output array.
 */
export function getUniqueLogIndex(events: { txnRef: string }[]): number[] {
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  for (const event of events) {
    const logIndex = uniqueTokenhashes[event.txnRef] ?? 0;
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.txnRef] = logIndex + 1;
  }
  return logIndexesForMessage;
}

type QuorumEvent = Log & { providers: string[] };

/**
 * EventManager can be used to obtain basic quorum validation of events emitted by multiple providers.
 * This can be useful with WebSockets, where events are emitted asynchronously.
 * This feature should eventually evolve into a wrapper for the Ethers WebSocketProvider type.
 */
export class EventManager {
  public readonly chain: string;
  public readonly events: { [eventHash: string]: QuorumEvent } = {};
  public readonly blockHashes: { [blockHash: string]: string[] } = {};

  constructor(
    private readonly logger: winston.Logger,
    public readonly chainId: number,
    public readonly quorum: number
  ) {
    this.chain = getNetworkName(chainId);
  }

  /**
   * Use a number of key attributes from an Ethers event to find any corresponding stored event. Note that this does
   * not guarantee an exact 1:1 match for the complete event. This is not possible without excluding numerous fields
   * on a per-event basis, because some providers append implementation-specific information to events. Rather, it
   * relies on known important fields matching.
   * @param event Event to search for.
   * @returns The matching event, or undefined.
   */
  findEvent(eventHash: string): QuorumEvent | undefined {
    return this.events[eventHash];
  }

  /**
   * For a given Log, identify its quorum based on the number of unique providers that have supplied it.
   * @param event A Log instance with appended provider information.
   * @returns The number of unique providers that reported this event.
   */
  getEventQuorum(eventHash: string): number {
    const storedEvent = this.findEvent(eventHash);
    return isDefined(storedEvent) ? dedupArray(storedEvent.providers).length : 0;
  }

  /**
   * For a given Log, identify its quorum based on the number of unique providers that have supplied it.
   * @param event A Log instance with appended provider information.
   * @returns The number of unique providers that reported this event.
   */
  protected _addEvent(eventHash: string, event: QuorumEvent): void {
    this.events[eventHash] = event;
    this.blockHashes[event.blockHash] ??= [];
    this.blockHashes[event.blockHash].push(eventHash);
  }

  /**
   * Record event receiption. Retain a record of the providers that have reported each event. This applies a
   * rudimentary quorum system to the event and ensures that providers agree on the events being transmitted.
   * @param event Event to be recorded.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns True when the event reaches quorum.
   */
  add(event: Log, provider: string): boolean {
    assert(!event.removed);

    const eventHash = this.hashEvent(event);

    // If `eventHash` is not recorded in `eventHashes` then it's presumed to be a new event. If it is
    // already found in the `eventHashes` array, then at least one provider has already supplied it.
    const storedEvent = this.findEvent(eventHash);

    // Store or update the set of events for this block number.
    if (!isDefined(storedEvent)) {
      // Event hasn't been seen before, so store it.
      this._addEvent(eventHash, { ...event, providers: [provider] });
      return this.quorum === 1;
    }

    if (storedEvent.providers.includes(provider)) {
      return false;
    }

    // Event has been seen before, but not from this provider. Store it.
    storedEvent.providers.push(provider);

    // If the event just hit quorum, notify the caller.
    return storedEvent.providers.length === this.quorum;
  }

  /**
   * Remove all events corresponding to a blockHash.
   * @param event Event that was removed.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns void
   */
  remove(event: Log, provider: string): void {
    assert(event.removed);

    const eventHashes = this.blockHashes[event.blockHash];
    const nEvents = eventHashes.length;
    if (nEvents > 0) {
      eventHashes.forEach((eventHash) => delete this.events[eventHash]);
      this.logger.warn({
        at: "EventManager::remove",
        message: `Dropped ${nEvents} event(s) at ${this.chain} block ${event.blockNumber}.`,
        provider,
      });
    }
  }

  /**
   * Produce a SHA256 hash representing an Ethers event, based on select input fields.
   * @param event An Ethers event to be hashed.
   * @returns A SHA256 string derived from the event.
   */
  hashEvent(event: Log): string {
    const { event: eventName, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, args } = event;
    const _args = this.flattenObject(args);
    const key = `${eventName}-${blockNumber}-${blockHash}-${transactionHash}-${transactionIndex}-${logIndex}-${_args}`;
    return ethersUtils.id(key);
  }

  /**
   * Recurse through an object and sort its keys in order to produce an ordered string of values.
   * @param obj Object to iterate through.
   * @returns string A hyphenated string containing all arguments of the object, sorted by key.
   */
  private flattenObject(obj: Record<string, unknown>): string {
    const args = Object.keys(obj)
      .sort()
      .map((k) => {
        const val = obj[k];
        // When val is a nested object, recursively flatten and stringify it.
        return typeof val === "object" ? this.flattenObject(val as Record<string, unknown>) : val;
      })
      .join("-");

    return args;
  }
}
