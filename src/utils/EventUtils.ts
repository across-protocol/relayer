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

// Retain events for at most this many blocks behind the slowest provider that is still keeping up with
// the same subscription. This must comfortably exceed any monitored chain's re-org depth — the only
// window in which a 'removed' notification can arrive — so pruning can never drop an event that could
// still be reorged out.
export const MAX_EVENT_RETENTION_BLOCKS = 5000;

// A provider lagging further than this behind the highest block observed on the same subscription is
// treated as stalled and no longer holds up eviction. This caps retention at MAX_PROVIDER_LAG_BLOCKS +
// MAX_EVENT_RETENTION_BLOCKS blocks, so a single dead subscription can't reinstate unbounded growth.
export const MAX_PROVIDER_LAG_BLOCKS = 5000;

/**
 * EventManager can be used to obtain basic quorum validation of events emitted by multiple providers.
 * This can be useful with WebSockets, where events are emitted asynchronously.
 * This feature should eventually evolve into a wrapper for the Ethers WebSocketProvider type.
 */
export class EventManager {
  public readonly chain: string;
  public readonly events: { [eventKey: string]: QuorumEvent } = {};
  public readonly blockHashes: { [blockHash: string]: string[] } = {};
  // Highest block observed per subscription, per provider. Each (address, event name) pair is a separate
  // stream that can stall independently, so they must not share a watermark.
  private readonly subscriptions: { [subscription: string]: { [provider: string]: number } } = {};
  private readonly nextLagWarningBlock: { [subscription: string]: number } = {};

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

    // The blockHash bucket exists only to service re-org removals, which are keyed on blockHash. SVM logs
    // carry no blockHash, so skip bucketing them; an empty key would otherwise collect every event on the
    // chain and drop all of them together.
    if (event.blockHash === "") {
      return;
    }
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

    // Bound retention: drop event/blockHash records that no longer need to be tracked, so the maps don't
    // grow unbounded for the process lifetime.
    this._pruneStaleEvents(event, provider);

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
   * Remove all events corresponding to a blockHash.
   * @param event Event that was removed.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns void
   */
  remove(event: Log, provider: string): void {
    assert(event.removed);

    const eventKeys = this.blockHashes[event.blockHash] ?? [];
    const nEvents = eventKeys.length;
    if (nEvents > 0) {
      eventKeys.forEach((eventKey) => delete this.events[eventKey]);
      this.logger.warn({
        at: "EventManager::remove",
        message: `Dropped ${nEvents} event(s) at ${this.chain} block ${event.blockNumber}.`,
        provider,
      });
    }
    // Also drop the now-stale blockHash bucket; previously only the events were removed, leaking this key.
    delete this.blockHashes[event.blockHash];
  }

  /**
   * Identify the subscription that supplies an event. Both listeners open one stream per (address, event
   * name) pair - see EventListener.onEvents() - and each stream can stall independently of the others, so
   * progress on one must never be read as progress on another.
   * @param event Event to identify.
   * @returns A key uniquely identifying the subscription.
   */
  protected getSubscriptionKey(event: Log): string {
    return `${event.address}-${event.event}`;
  }

  /**
   * Evict event records that can no longer be reorged out or receive a late quorum vote. Eviction is
   * anchored on the slowest provider that is still keeping up with the same subscription, so a lagging
   * stream can always cast its vote on an event that another provider reported earlier; the anchor is
   * clamped to MAX_PROVIDER_LAG_BLOCKS behind that subscription's highest block, so a stalled provider
   * can't hold retention open forever. Only scans when the subscription advances, so amortised cost stays
   * low and the maps stay bounded.
   * @param event Event currently being processed.
   * @param provider A string uniquely identifying the provider that supplied the event.
   */
  private _pruneStaleEvents(event: Log, provider: string): void {
    const { blockNumber } = event;
    const subscription = this.getSubscriptionKey(event);
    const blockNumbers = (this.subscriptions[subscription] ??= {});
    if (!(blockNumber > (blockNumbers[provider] ?? 0))) {
      return; // This subscription hasn't advanced, so its cutoff can't have moved.
    }
    blockNumbers[provider] = blockNumber;

    // Providers that have stalled on this subscription - or that haven't reported on it yet - are pinned
    // at MAX_PROVIDER_LAG_BLOCKS behind, rather than being permitted to defeat the memory bound.
    const observed = Object.values(blockNumbers);
    const highestBlockNumber = Math.max(...observed);
    const stalledBlockNumber = highestBlockNumber - MAX_PROVIDER_LAG_BLOCKS;
    this._warnOnStalledProviders(subscription, highestBlockNumber, stalledBlockNumber);

    const slowestBlockNumber = observed.length >= this.quorum ? Math.min(...observed) : 0;
    const cutoff = Math.max(slowestBlockNumber, stalledBlockNumber) - MAX_EVENT_RETENTION_BLOCKS;
    if (cutoff <= 0) {
      return;
    }

    // Evict per event, not per blockHash bucket: SVM logs carry no blockHash, so a bucket does not
    // reliably correspond to a single block, and the events within it don't share a block number.
    const staleKeys = new Set<string>();
    Object.entries(this.events).forEach(([eventKey, storedEvent]) => {
      if (storedEvent.blockNumber < cutoff && this.getSubscriptionKey(storedEvent) === subscription) {
        staleKeys.add(eventKey);
        delete this.events[eventKey];
      }
    });
    if (staleKeys.size === 0) {
      return;
    }

    // Compact the affected blockHash buckets in a single pass; splicing per key would be quadratic.
    Object.entries(this.blockHashes).forEach(([blockHash, eventKeys]) => {
      const retained = eventKeys.filter((eventKey) => !staleKeys.has(eventKey));
      if (retained.length === 0) {
        delete this.blockHashes[blockHash];
      } else if (retained.length < eventKeys.length) {
        this.blockHashes[blockHash] = retained;
      }
    });
  }

  /**
   * Warn about providers lagging so far behind on a subscription that their votes are no longer being
   * retained. Events they subsequently report can no longer reach quorum, so surface it instead of
   * silently dropping events. Rate-limited to one warning per MAX_PROVIDER_LAG_BLOCKS of progression.
   * @param subscription Subscription being evaluated.
   * @param highestBlockNumber Highest block observed on this subscription, across all providers.
   * @param stalledBlockNumber Block number below which a provider is considered stalled.
   */
  private _warnOnStalledProviders(subscription: string, highestBlockNumber: number, stalledBlockNumber: number): void {
    if (highestBlockNumber < (this.nextLagWarningBlock[subscription] ?? 0)) {
      return;
    }
    const providers = Object.entries(this.subscriptions[subscription])
      .filter(([, blockNumber]) => blockNumber < stalledBlockNumber)
      .map(([provider, blockNumber]) => ({ provider, blockNumber }));
    if (providers.length === 0) {
      return;
    }
    this.nextLagWarningBlock[subscription] = highestBlockNumber + MAX_PROVIDER_LAG_BLOCKS;
    this.logger.warn({
      at: "EventManager::_pruneStaleEvents",
      message: `Ignoring stalled ${this.chain} provider(s) when evicting stale events.`,
      subscription,
      highestBlockNumber,
      providers,
    });
  }

  // Key on canonical on-chain identity; avoids drift between viem/ethers parsings of the same log.
  getEventKey(event: Log): string {
    const { event: eventName, blockHash, transactionHash, logIndex } = event;
    return `${eventName}-${blockHash}-${transactionHash}-${logIndex}`;
  }
}
