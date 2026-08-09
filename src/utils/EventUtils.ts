import assert from "assert";
import winston from "winston";
import { BigNumber } from "ethers";
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

// Bound the size of args logged on a quorum conflict; event args (i.e. message) are unbounded.
const MAX_LOGGED_ARGS_LEN = 1024;

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
   * @returns The quorum-validated event when the event reaches quorum, otherwise undefined.
   */
  add(event: Log, provider: string): Log | undefined {
    assert(!event.removed);

    const eventKey = this.getEventKey(event);

    // If `eventKey` is not recorded then it's presumed to be a new event. If it is already found,
    // then at least one provider has already supplied it.
    const storedEvent = this.findEvent(eventKey);

    // Store or update the set of events for this block number.
    if (!isDefined(storedEvent)) {
      // Event hasn't been seen before, so store it.
      const newEvent = { ...event, providers: [provider] };
      this._addEvent(eventKey, newEvent);
      return this.quorum === 1 ? this.quorumEvent(newEvent) : undefined;
    }

    if (storedEvent.providers.includes(provider)) {
      return undefined;
    }

    // The event key covers on-chain identity only, so a provider can supply a known-good identity alongside
    // fabricated event arguments. Require the provider to agree on the arguments of the first-seen event
    // before crediting it towards quorum. Identity fields that providers legitimately disagree on
    // (blockNumber, transactionIndex) remain excluded - see getEventKey().
    const [storedArgs, rejectedArgs] = [this.argsKey(storedEvent.args), this.argsKey(event.args)];
    if (storedArgs !== rejectedArgs) {
      this.logger.error({
        at: "EventManager::add",
        message: `Rejected conflicting ${this.chain} ${event.event} event arguments from ${provider}.`,
        notificationPath: "across-error",
        eventKey,
        provider,
        quorumProviders: storedEvent.providers,
        // Truncated; a lying provider controls the size of its own args.
        storedArgs: storedArgs.slice(0, MAX_LOGGED_ARGS_LEN),
        rejectedArgs: rejectedArgs.slice(0, MAX_LOGGED_ARGS_LEN),
      });
      return undefined;
    }

    // Event has been seen before, but not from this provider. Store it.
    storedEvent.providers.push(provider);

    // If the event just hit quorum, notify the caller. Always relay the first-seen event, never the caller's
    // copy; the latter is supplied by whichever provider happened to complete quorum.
    return storedEvent.providers.length === this.quorum ? this.quorumEvent(storedEvent) : undefined;
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

  /**
   * Produce a stable, order-independent representation of a decoded event's arguments. Values are normalised
   * so that providers disagreeing only on representation (bigint vs. BigNumber vs. number, hex casing) are not
   * mistaken for providers disagreeing on content. Only hex strings are case-folded; other strings (i.e. base58
   * addresses on SVM) are case-sensitive.
   * @param args Decoded event arguments.
   * @returns A deterministic string representation of args.
   */
  argsKey(args: Log["args"]): string {
    return JSON.stringify(this.normaliseArg(args));
  }

  private normaliseArg(value: unknown): unknown {
    if (!isDefined(value)) {
      return null;
    }
    if (BigNumber.isBigNumber(value)) {
      return value.toString();
    }
    // Note: ethers Result instances are arrays with additional named properties duplicating the indexed ones.
    if (Array.isArray(value)) {
      return value.map((v) => this.normaliseArg(v));
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(obj)
          .sort()
          .map((key) => [key, this.normaliseArg(obj[key])])
      );
    }
    if (typeof value === "string") {
      return /^0x[0-9a-f]*$/i.test(value) ? value.toLowerCase() : value;
    }
    return String(value); // bigint, number, boolean.
  }

  // Strip EventManager-internal bookkeeping before relaying a quorum-validated event to the caller.
  private quorumEvent(storedEvent: QuorumEvent): Log {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { providers, ...event } = storedEvent;
    return event;
  }
}
