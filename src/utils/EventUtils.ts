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
 * @notice Returns an array with the same length as the passed in Event array where each index is assigned a new index
 * that states its relative position to other events with the same transaction hash. If two or more of the input
 * events have the same transaction hash, they will be assigned unique indices starting at 0 and counting up based
 * on the order of events passed in.
 * @param events List of objects to pass in that contain a transaction hash.
 * @return Index for each event based on the # of other input events with the same transaction hash. The order of the
 * input events is preserved in the output array.
 */
export function getUniqueLogIndex(events: { transactionHash: string }[]): number[] {
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  for (const event of events) {
    const logIndex = uniqueTokenhashes[event.transactionHash] ?? 0;
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] = logIndex + 1;
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
  public readonly events: { [blockNumber: number]: QuorumEvent[] } = {};
  public readonly processedEvents: Set<string> = new Set();

  private blockNumber: number;

  constructor(
    private readonly logger: winston.Logger,
    public readonly chainId: number,
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
  findEvent(event: Log): QuorumEvent | undefined {
    return this.events[event.blockNumber]?.find(
      (storedEvent) =>
        storedEvent.logIndex === event.logIndex &&
        storedEvent.transactionIndex === event.transactionIndex &&
        storedEvent.transactionHash === event.transactionHash &&
        this.hashEvent(storedEvent) === this.hashEvent(event)
    );
  }

  /**
   * For a given Log, verify whether it has already been processed.
   * @param event An Log instance to check.
   * @returns True if the event has been processed, else false.
   */
  protected isEventProcessed(event: Log): boolean {
    // Protect against re-sending this event if it later arrives from another provider.
    const eventKey = this.hashEvent(event);
    return this.processedEvents.has(eventKey);
  }

  /**
   * For a given Log, mark it has having been been processed.
   * @param event A Log instance to mark processed.
   * @returns void
   */
  protected markEventProcessed(event: Log): void {
    // Protect against re-sending this event if it later arrives from another provider.
    const eventKey = this.hashEvent(event);
    this.processedEvents.add(eventKey);
  }

  /**
   * For a given Log, identify its quorum based on the number of unique providers that have supplied it.
   * @param event A Log instance with appended provider information.
   * @returns The number of unique providers that reported this event.
   */
  getEventQuorum(event: Log): number {
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
  add(event: Log, provider: string): void {
    assert(!event.removed);

    if (this.isEventProcessed(event)) {
      return;
    }

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
  remove(event: Log, provider: string): void {
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
   * Record a new block. This function triggers the existing queue of pending events to be evaluated for quorum.
   * Events meeting quorum criteria are submitted to the parent process (if defined). Events submitted are
   * subsequently flushed from this class.
   * @param blockNumber Number of the latest block.
   * @returns void
   */
  tick(blockNumber: number): Log[] {
    this.blockNumber = blockNumber > this.blockNumber ? blockNumber : this.blockNumber;
    const blockNumbers = Object.keys(this.events)
      .map(Number)
      .sort((x, y) => x - y);
    const quorumEvents: QuorumEvent[] = [];

    blockNumbers.forEach((blockNumber) => {
      // Filter out events that have reached quorum for propagation.
      this.events[blockNumber] = this.events[blockNumber].filter((event) => {
        if (this.quorum > this.getEventQuorum(event)) {
          return true; // No quorum; retain for next time.
        }

        this.markEventProcessed(event);
        quorumEvents.push(event);
        return false;
      });
    });

    // Strip out the quorum information before returning.
    return quorumEvents.map(({ providers, ...event }) => event);
  }

  /**
   * Produce a SHA256 hash representing an Ethers event, based on select input fields.
   * @param event An Ethers event to be hashed.
   * @returns A SHA256 string derived from the event.
   */
  hashEvent(event: Log): string {
    const { event: eventName, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, args } = event;
    const _args = Object.values(args).join("-");
    const key = `${eventName}-${blockNumber}-${blockHash}-${transactionHash}-${transactionIndex}-${logIndex}-${_args}`;
    return ethersUtils.id(key);
  }
}
