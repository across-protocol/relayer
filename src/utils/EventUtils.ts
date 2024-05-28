import assert from "assert";
import winston from "winston";
import { Event, utils as ethersUtils } from "ethers";
import { getNetworkName } from "./NetworkUtils";
import { dedupArray } from "./SDKUtils";
import { isDefined } from "./TypeGuards";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";

export type EventSearchConfig = sdkUtils.EventSearchConfig;

export const {
  getPaginatedBlockRanges,
  getTransactionHashes,
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
 * Sub out the array component of `args` to ensure it's correctly stringified before transmission.
 * Stringification of an Ethers event can produce unreliable results for Event.args and it can be consolidated into an
 * array, dropping the named k/v pairs.
 * @param event An Ethers event.
 * @returns A modified Ethers event, ensuring that the Event.args object consists of named k/v pairs.
 */
export function mangleEventArgs(event: Event): Event {
  return { ...event, args: sdkUtils.spreadEvent(event.args) };
}

/**
 * @notice Returns an array with the same length as the passed in Event array where each index is assigned a new index
 * that states its relative position to other events with the same transaction hash. If two or more of the input
 * events have the same transaction hash, they will be assigned unique indices starting at 0 and counting up based
 * on the order of events passed in.
 * @param events List of objects to pass in that contain a transaction hash.
 * @return Index for each event based on the # of other input events with the same transaction hash. The order of the
 * input events is preserved in the output array.
 */
export function getUniqueLogIndex(events: { transactionHash: string }[]): number[] {
  const uniqueTokenhashes: Record<string, number> = {};
  const logIndexesForMessage = [];
  for (const event of events) {
    const logIndex = uniqueTokenhashes[event.transactionHash] ?? 0;
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] = logIndex + 1;
  }
  return logIndexesForMessage;
}

/**
 * EventManager can be used to obtain basic quorum validation of events emitted by multiple providers.
 * This can be useful with WebSockets, where events are emitted asynchronously.
 * This feature should eventually evolve into a wrapper for the Ethers WebSocketProvider type.
 */
export class EventManager {
  public readonly chain: string;
  public readonly events: { [blockNumber: number]: (Event & { providers: string[] })[] } = {};

  private blockNumber: number;

  constructor(
    private readonly logger: winston.Logger,
    public readonly chainId: number,
    public readonly finality: number,
    public readonly quorum: number
  ) {
    this.chain = getNetworkName(chainId);
    this.blockNumber = 0;
  }

  /**
   * Use a number of key attributes from an Ethers event to find any corresponding stored event. Note that this does
   * not guarantee an exact 1:1 match for the complete event. This is not possible without excluding numerous fields
   * on a per-event basis, because some providers append implementation-specific information to events. Rather, it
   * relies on known important fields matching.
   * @param event Event to search for.
   * @returns The matching event, or undefined.
   */
  findEvent(event: Event): (Event & { providers: string[] }) | undefined {
    return this.events[event.blockNumber]?.find(
      (storedEvent) =>
        storedEvent.logIndex === event.logIndex &&
        storedEvent.transactionIndex === event.transactionIndex &&
        storedEvent.transactionHash === event.transactionHash &&
        this.hashEvent(storedEvent) === this.hashEvent(event)
    );
  }

  /**
   * For a given Ethers Event, identify its quorum based on the number of unique providers that have supplied it.
   * @param event An Ethers Event with appended provider information.
   * @returns The number of unique providers that reported this event.
   */
  getEventQuorum(event: Event): number {
    const storedEvent = this.findEvent(event);
    return isDefined(storedEvent) ? dedupArray(storedEvent.providers).length : 0;
  }

  /**
   * Record an Ethers event. If quorum is 1 then the event will be enqueued for transfer. If this is a new event and
   * quorum > 1 then its hash will be recorded for future reference. If the same event is received multiple times then
   * it will be enqueued for transfer. This applies a rudimentary quorum system to the event and ensures that providers
   * agree on the events being transmitted.
   * @param event Ethers event to be recorded.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns void
   */
  add(event: Event, provider: string): void {
    assert(!event.removed);

    // If `eventHash` is not recorded in `eventHashes` then it's presumed to be a new event. If it is
    // already found in the `eventHashes` array, then at least one provider has already supplied it.
    const events = (this.events[event.blockNumber] ??= []);
    const storedEvent = this.findEvent(event);

    // Store or update the set of events for this block number.
    if (!isDefined(storedEvent)) {
      // Event hasn't been seen before, so store it.
      events.push({ ...event, providers: [provider] });
    } else {
      if (!storedEvent.providers.includes(provider)) {
        // Event has been seen before, but not from this provider. Store it.
        storedEvent.providers.push(provider);
      }
    }
  }

  /**
   * Remove an Ethers event. This event may have previously been ingested, and subsequently invalidated due to a chain
   * re-org.
   * @param event Ethers event to be recorded.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns void
   */
  remove(event: Event, provider: string): void {
    assert(event.removed);

    const events = this.events[event.blockNumber] ?? [];

    // Filter coarsely on transactionHash, since a reorg should invalidate multiple events within a single transaction hash.
    const eventIdxs = events
      .map((event, idx) => ({ ...event, idx }))
      .filter(({ blockHash }) => blockHash === event.blockHash)
      .map(({ idx }) => idx);

    if (eventIdxs.length > 0) {
      // Remove each event in reverse to ensure that indexes remain valid until the last has been removed.
      eventIdxs.reverse().forEach((idx) => events.splice(idx, 1));

      this.logger.warn({
        at: "EventManager::remove",
        message: `Dropped ${eventIdxs.length} event(s) at ${this.chain} block ${event.blockNumber}.`,
        provider,
      });
    }
  }

  /**
   * Record a new block. This function triggers the existing queue of pending events to be evaluated for basic finality.
   * Events meeting finality criteria are submitted to the parent process (if defined). Events submitted are
   * subsequently flushed from this class.
   * @param blockNumber Number of the latest block.
   * @returns void
   */
  tick(blockNumber: number): Event[] {
    this.blockNumber = blockNumber > this.blockNumber ? blockNumber : this.blockNumber;

    // After `finality` blocks behind head, events for a block are considered finalised.
    // This is configurable and will almost always be less than chain finality guarantees.
    const finalised = blockNumber - this.finality;

    // Collect the events that met quorum, stripping out the provider information.
    const events = (this.events[finalised] ?? [])
      .filter((event) => this.getEventQuorum(event) >= this.quorum)
      .map(({ providers, ...event }) => event);

    // Flush the events that were just submitted.
    delete this.events[finalised];

    return events;
  }

  /**
   * Produce a SHA256 hash representing an Ethers event, based on select input fields.
   * @param event An Ethers event to be hashed.
   * @returns A SHA256 string derived from the event.
   */
  hashEvent(event: Event): string {
    const { event: eventName, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, args } = event;
    return ethersUtils.id(
      `${eventName}-${blockNumber}-${blockHash}-${transactionHash}-${transactionIndex}-${logIndex}-${args.join("-")}`
    );
  }
}
