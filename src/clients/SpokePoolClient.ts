import assert from "assert";
import { ChildProcess } from "child_process";
import { Contract, Event } from "ethers";
import { array, integer, object, min as Min, string } from "superstruct";
import { clients, typeguards, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { getNetworkName, isDefined, winston } from "../utils";

export type SpokePoolClient = clients.SpokePoolClient;

type SpokePoolEventRemoved = {
  transactionHash: string;
  eventNames: string[];
};

type SpokePoolEventsAdded = {
  blockNumber: number;
  currentTime: number;
  oldestTime: number;
  nEvents: number; // Number of events.
  data: string;
};

export type SpokePoolClientMessage = SpokePoolEventsAdded | SpokePoolEventRemoved;

const EventsAddedMessage = object({
  blockNumber: Min(integer(), 0),
  currentTime: Min(integer(), 0),
  oldestTime: Min(integer(), 0),
  nEvents: Min(integer(), 0),
  data: string(),
});

const EventRemovedMessage = object({
  transactionHash: string(),
  eventNames: array(string()),
});

export function isSpokePoolEventsAdded(message: unknown): message is SpokePoolEventsAdded {
  return EventsAddedMessage.is(message);
}

export function isSpokePoolEventRemoved(message: unknown): message is SpokePoolEventRemoved {
  return EventRemovedMessage.is(message);
}

export class IndexedSpokePoolClient extends clients.SpokePoolClient {
  public chain: string;

  private pendingBlockNumber: number;
  private pendingCurrentTime: number;
  private pendingOldestTime: number;

  private pendingEvents: Event[][];
  private pendingEventsRemoved: SpokePoolEventRemoved[];

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    readonly hubPoolClient: clients.HubPoolClient | null,
    readonly chainId: number,
    public deploymentBlock: number,
    readonly worker?: ChildProcess
  ) {
    // EventSearchConfig isn't required for this SpokePoolClient specialisation, so sub in dummy values.
    const eventSearchConfig = { fromBlock: 0, toBlock: 0 };
    super(logger, spokePool, hubPoolClient, chainId, deploymentBlock, eventSearchConfig);

    this.chain = getNetworkName(chainId);
    this.pendingBlockNumber = deploymentBlock;
    this.pendingCurrentTime = 0;
    this.pendingEvents = this.queryableEventNames.map(() => []);
    this.pendingEventsRemoved = [];
  }

  /**
   * Listen for indexer updates.
   * @returns void
   */
  init(): void {
    if (isDefined(this.worker)) {
      this.worker.on("message", (message) => this.indexerUpdate(message));
      this.logger.debug({ at: "SpokePoolClient#init", message: "Listening for ${this.chain} events." });
    }
  }

  /**
   * Receive an update from the external indexer process.
   * @param rawMessage Message to be parsed.
   * @returns void
   */
  protected indexerUpdate(rawMessage: unknown): void {
    if (typeof rawMessage !== "string") {
      return;
    }

    let message: SpokePoolClientMessage;
    try {
      message = JSON.parse(rawMessage);
    } catch (err) {
      const error = typeguards.isError(err) ? err.message : "unknown error";
      this.logger.warn({
        at: "SpokePoolClient#indexerUpdate",
        message: `Received malformed message from ${this.chain} indexed.`,
        error,
      });
      return;
    }

    if (isSpokePoolEventRemoved(message)) {
      this.pendingEventsRemoved.push(message);
      return;
    }

    if (!isSpokePoolEventsAdded(message)) {
      this.logger.warn({
        at: "SpokePoolClient#indexerUpdate",
        message: `Received unrecognised message from ${this.chain} indexer.`,
        data: message,
      });
      return;
    }

    const { blockNumber, currentTime, oldestTime, nEvents, data } = message;
    if (nEvents > 0) {
      const pendingEvents = JSON.parse(data, sdkUtils.jsonReviverWithBigNumbers);
      if (!Array.isArray(pendingEvents) || pendingEvents.length !== nEvents) {
        this.logger.warn({
          at: "SpokePoolClient#indexerUpdate",
          message: `Received malformed event update events from ${this.chain} indexer.`,
          blockNumber,
          nEvents,
          pendingEvents,
        });
        return;
      }

      this.logger.debug({
        at: "SpokePoolClient#indexerUpdate",
        message: `Received ${nEvents} ${this.chain} events from indexer.`,
      });

      pendingEvents.forEach((event) => {
        const eventIdx = this.queryableEventNames.indexOf(event.event);
        if (eventIdx === -1 || event.removed) {
          this.logger.warn({
            at: "SpokePoolClient#indexerUpdate",
            message: `Received unrecognised or invalid event from ${this.chain} indexer.`,
            event,
          });
          return;
        }

        this.pendingEvents[eventIdx].push(event);
      });
    }

    this.pendingBlockNumber = blockNumber;
    this.pendingCurrentTime = currentTime;
    if (!isDefined(this.pendingOldestTime) && oldestTime > 0) {
      this.pendingOldestTime = oldestTime;
    }
  }

  /**
   * Given an event to be removed, ensure that it is removed from the set of ingested events.
   * @param event An Ethers event instance.
   * @returns void
   */
  protected removeEvent(transactionHash: string, eventNames: string[]): boolean {
    let removed = false;
    this.logger.debug({
      at: "SpokePoolClient::removeEvent",
      message: `Removing event(s) for ${this.chain} transactionHash.`,
      transactionHash,
    });

    eventNames.forEach((eventName) => {
      const eventIdx = this.queryableEventNames.indexOf(eventName);
      const pendingEvents = this.pendingEvents[eventIdx];

      // First check for removal from any pending events.
      const pendingEventIdxs = pendingEvents
        .map((pending, idx) => ({ ...pending, idx }))
        .filter((pending) => pending.transactionHash === transactionHash)
        .map(({ idx }) => idx);

      if (pendingEventIdxs.length > 0) {
        removed = true;

        const { blockNumber } = pendingEvents[pendingEventIdxs[0]];

        // Splice out the events in reverse order.
        pendingEventIdxs.reverse().forEach((idx) => pendingEvents.splice(idx, 1));

        this.logger.debug({
          at: "SpokePoolClient#removeEvent",
          message: `Removed ${this.chain} ${eventName} event for block ${blockNumber}.`,
          transactionHash,
        });
      }

      // Back out any events that were previously ingested via update(). This is best-effort and may help to save the
      // relayer from filling a deposit where it must wait for additional deposit confirmations. Note that this is
      // _unsafe_ to do ad-hoc, since it may interfere with some ongoing relayer computations relying on the
      // depositHashes object. If that's an acceptable risk then it might be preferable to simply assert().
      if (eventName === "V3FundsDeposited") {
        const depositHashes = Object.values(this.depositHashes)
          .filter((deposit) => deposit.transactionHash === transactionHash)
          .map((deposit) => this.getDepositHash(deposit));

        depositHashes.forEach((hash) => delete this.depositHashes[hash]);

        this.logger.warn({
          at: "SpokePoolClient#removeEvent",
          message: `Removed ${depositHashes.length} pre-ingested ${this.chain} ${eventName} events.`,
          transactionHash,
        });
      } else if (eventName === "EnabledDepositRoute") {
        // These are hard to back out because they're not stored with transaction information. They should be extremely
        // rare, but at the margins could risk making an invalid fill based on the resolved outputToken for a deposit
        // that specifies outputToken 0x0. Simply bail in this case; everything should be OK on the next run.
        assert(false, "Detected re-org affecting deposit route events.");
      } else {
        // Retaining any remaining event types should be non-critical for relayer operation. They may
        // produce sub-optimal decisions, but should not affect the correctness of relayer operation.
        this.logger.warn({
          at: "SpokePoolClient#removeEvent",
          message: `Detected re-org affecting pre-ingested ${this.chain} ${eventName} events. Ignoring.`,
          transactionHash,
        });
      }
    });

    return removed;
  }

  protected async _update(eventsToQuery: string[]): Promise<clients.SpokePoolUpdate> {
    // If any events have been removed upstream, remove them first.
    this.pendingEventsRemoved = this.pendingEventsRemoved.filter(({ transactionHash, eventNames }) =>
      this.removeEvent(transactionHash, eventNames)
    );

    const events = eventsToQuery.map((eventName) => {
      const eventIdx = this.queryableEventNames.indexOf(eventName);
      assert(eventIdx !== -1);

      const pendingEvents = this.pendingEvents[eventIdx];
      this.pendingEvents[eventIdx] = [];

      pendingEvents.forEach(({ removed }) => assert(!removed));
      return pendingEvents;
    });

    // Find the latest deposit Ids, and if there are no new events, fall back to already stored values.
    const fundsDeposited = eventsToQuery.indexOf("V3FundsDeposited");
    const [firstDepositId, latestDepositId] = [
      events[fundsDeposited].at(0)?.args?.depositId ?? this.getDeposits().at(0) ?? 0,
      events[fundsDeposited].at(-1)?.args?.depositId ?? this.getDeposits().at(-1) ?? 0,
    ];

    return {
      success: true,
      currentTime: this.pendingCurrentTime,
      oldestTime: this.pendingOldestTime,
      firstDepositId,
      latestDepositId,
      searchEndBlock: this.pendingBlockNumber,
      events,
    };
  }
}
