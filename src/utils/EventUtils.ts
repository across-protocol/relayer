import assert from "assert";
import winston from "winston";
import { Log as viemLog } from "viem";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { Log } from "../interfaces";
import { getNetworkName } from "./NetworkUtils";
import { dedupArray } from "./SDKUtils";
import { isDefined } from "./TypeGuards";

type ViemEventLog = viemLog & { args: unknown; eventName: string };

/**
 * Convert a viem watchEvent log into the relayer's ethers-shaped Log.
 * Returns undefined for pending logs (where viem nulls block-confirmation fields)
 * or non-record event args; callers should skip such entries.
 */
export function viemLogToEthersLog(raw: ViemEventLog): Log | undefined {
  if (
    raw.blockHash === null ||
    raw.transactionHash === null ||
    raw.transactionIndex === null ||
    raw.logIndex === null ||
    typeof raw.args !== "object" ||
    raw.args === null ||
    Array.isArray(raw.args)
  ) {
    return undefined;
  }
  return {
    ...raw,
    blockHash: raw.blockHash,
    transactionHash: raw.transactionHash,
    transactionIndex: raw.transactionIndex,
    logIndex: raw.logIndex,
    args: raw.args,
    blockNumber: Number(raw.blockNumber),
    event: raw.eventName,
    topics: Array<string>(), // viem doesn't supply topics, but the relayer doesn't read them either.
  };
}

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
  const uniqueTokenhashes: Record<string, number> = {};
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
  public readonly events: { [eventKey: string]: QuorumEvent } = {};
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
  findEvent(eventKey: string): QuorumEvent | undefined {
    return this.events[eventKey];
  }

  /**
   * For a given Log, identify its quorum based on the number of unique providers that have supplied it.
   * @param event A Log instance with appended provider information.
   * @returns The number of unique providers that reported this event.
   */
  getEventQuorum(eventKey: string): number {
    const storedEvent = this.findEvent(eventKey);
    return isDefined(storedEvent) ? dedupArray(storedEvent.providers).length : 0;
  }

  /**
   * For a given Log, identify its quorum based on the number of unique providers that have supplied it.
   * @param event A Log instance with appended provider information.
   * @returns The number of unique providers that reported this event.
   */
  protected _addEvent(eventKey: string, event: QuorumEvent): void {
    this.events[eventKey] = event;
    this.blockHashes[event.blockHash] ??= [];
    this.blockHashes[event.blockHash].push(eventKey);
  }

  /**
   * Record event reception. Retain a record of the providers that have reported each event. This applies a
   * rudimentary quorum system to the event and ensures that providers agree on the events being transmitted.
   * @param event Event to be recorded.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns True when the event reaches quorum.
   */
  add(event: Log, provider: string): boolean {
    assert(!event.removed);

    const eventKey = this.getEventKey(event);

    // If `eventKey` is not recorded then it's presumed to be a new event. If it is already found,
    // then at least one provider has already supplied it.
    const storedEvent = this.findEvent(eventKey);

    // Store or update the set of events for this block number.
    if (!isDefined(storedEvent)) {
      // Event hasn't been seen before, so store it.
      this._addEvent(eventKey, { ...event, providers: [provider] });
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
   * Retract `provider`'s votes for events above a re-org fork point. Only events that fall below
   * quorum as a result are returned (for removal), so one provider's fork can't evict events the
   * others still confirm.
   */
  reorg(provider: string, forkedBlock: number): Log[] {
    const orphaned: Log[] = [];
    Object.entries(this.events).forEach(([eventKey, event]) => {
      if (event.blockNumber <= forkedBlock) {
        return;
      }
      const providerIdx = event.providers.indexOf(provider);
      if (providerIdx === -1) {
        return;
      }

      const hadQuorum = event.providers.length >= this.quorum;
      event.providers.splice(providerIdx, 1);
      if (hadQuorum && event.providers.length < this.quorum) {
        orphaned.push(event);
      }

      if (event.providers.length === 0) {
        delete this.events[eventKey];
        const keys = this.blockHashes[event.blockHash];
        if (isDefined(keys)) {
          const keyIdx = keys.indexOf(eventKey);
          if (keyIdx !== -1) {
            keys.splice(keyIdx, 1);
          }
          if (keys.length === 0) {
            delete this.blockHashes[event.blockHash];
          }
        }
      }
    });
    return orphaned;
  }

  /**
   * Remove all events corresponding to a blockHash.
   * @param event Event that was removed.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns void
   */
  remove(event: Log, provider: string): void {
    assert(event.removed);

    const eventKeys = this.blockHashes[event.blockHash];
    const nEvents = eventKeys.length;
    if (nEvents > 0) {
      eventKeys.forEach((eventKey) => delete this.events[eventKey]);
      this.logger.warn({
        at: "EventManager::remove",
        message: `Dropped ${nEvents} event(s) at ${this.chain} block ${event.blockNumber}.`,
        provider,
      });
    }
  }

  // Key on canonical on-chain identity; avoids drift between viem/ethers parsings of the same log.
  getEventKey(event: Log): string {
    const { event: eventName, blockHash, transactionHash, logIndex } = event;
    return `${eventName}-${blockHash}-${transactionHash}-${logIndex}`;
  }
}
