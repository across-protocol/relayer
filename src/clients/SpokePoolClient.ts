import assert from "assert";
import { ChildProcess } from "child_process";
import { Contract, Event } from "ethers";
import { clients, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { EventSearchConfig, getNetworkName, isDefined, MakeOptional, winston } from "../utils";

export const { SpokePoolClient } = clients;

export type SpokePoolClient = clients.SpokePoolClient;

type SpokePoolEventRemoved = {
  event: string;
};

type SpokePoolEventsAdded = {
  blockNumber: number;
  currentTime: number;
  nEvents: number; // Number of events.
  data: string;
};

export type SpokePoolClientMessage = SpokePoolEventsAdded | SpokePoolEventRemoved;

export function isSpokePoolEventsAdded(message: SpokePoolClientMessage): message is SpokePoolEventsAdded {
  return isDefined((message as SpokePoolEventsAdded).blockNumber);
}

export function isSpokePoolEventRemoved(message: SpokePoolClientMessage): message is SpokePoolEventRemoved {
  return isDefined((message as SpokePoolEventRemoved).event);
}

export class IndexedSpokePoolClient extends SpokePoolClient {
  public chain: string;

  private pendingBlockNumber: number;
  private pendingCurrentTime: number;

  private pendingEvents: Event[][];
  private pendingEventsRemoved: Event[];

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    readonly hubPoolClient: clients.HubPoolClient | null,
    readonly chainId: number,
    public deploymentBlock: number,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    readonly worker: ChildProcess
  ) {
    super(logger, spokePool, hubPoolClient, chainId, deploymentBlock, eventSearchConfig);

    this.chain = getNetworkName(chainId);
    this.pendingBlockNumber = deploymentBlock;
    this.pendingCurrentTime = 0;
    this.pendingEvents = this.queryableEventNames.map(() => []);
    this.pendingEventsRemoved = [];

    if (isDefined(this.worker)) {
      this.worker.on("message", (rawMessage: string) => {
        const message = JSON.parse(rawMessage);

        if (isSpokePoolEventRemoved(message)) {
          const event = JSON.parse(message.event, sdkUtils.jsonReviverWithBigNumbers);
          // @todo: Verify the shape of event.
          this.pendingEventsRemoved.push(event);
          return;
        }

        if (!isSpokePoolEventsAdded(message)) {
          this.logger.warn({
            at: "SpokePoolClient#receive",
            message: `Received unrecognised message from ${this.chain} indexer.`,
            data: message,
          });
          return;
        }

        const { blockNumber, currentTime, nEvents, data } = message;
        if (nEvents > 0) {
          const pendingEvents = JSON.parse(data, sdkUtils.jsonReviverWithBigNumbers);
          if (!Array.isArray(pendingEvents) || pendingEvents.length !== nEvents) {
            this.logger.warn({
              at: "SpokePoolClient#receive",
              message: `Received malformed event update events from ${this.chain} indexer.`,
              blockNumber,
              nEvents,
              pendingEvents,
            });
            return;
          }

          this.logger.debug({
            at: "SpokePoolClient#receive",
            message: `Received ${nEvents} ${this.chain} events from indexer.`,
          });

          pendingEvents.forEach((event) => {
            const eventIdx = this.queryableEventNames.indexOf(event.event);
            if (eventIdx === -1 || event.removed) {
              this.logger.warn({
                at: "SpokePoolClient#receive",
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
      });
    }
  }

  /**
   * Given an event to be removed, ensure that it is removed from the set of ingested events.
   * @param event An Ethers event instance.
   * @returns void
   */
  protected removeEvent(event: Event): boolean {
    let removed = false;
    this.logger.debug({ at: "SpokePoolClient::removeEvent", message: "Removing event.", event });

    const { event: eventName } = event;
    const eventIdx = this.queryableEventNames.indexOf(eventName);
    const pendingEvents = this.pendingEvents[eventIdx];

    // First check for removal from any pending events.
    const { idx: pendingEventIdx } = pendingEvents
      .map((pendingEvent, idx) => ({ ...pendingEvent, idx }))
      .find(
        (pendingEvent) =>
          pendingEvent.blockHash === event.blockHash &&
          pendingEvent.topics[0] === event.topics[0] &&
          pendingEvent.transactionHash === event.transactionHash &&
          pendingEvent.transactionIndex === event.transactionIndex &&
          pendingEvent.logIndex === event.logIndex
      );

    if (isDefined(pendingEventIdx)) {
      removed = true;
      pendingEvents.splice(pendingEventIdx, 1);
      this.logger.debug({
        at: "SpokePoolClient#removeEvent",
        message: `Removed ${getNetworkName(this.chainId)} ${eventName} event for block ${event.blockNumber}.`,
        transactionHash: event.transactionHash,
      });
    }

    // @todo: Back out any events that were previously ingested!
    return removed;
  }

  protected async _update(eventsToQuery: string[]): Promise<clients.SpokePoolUpdate> {
    // If any events have been removed upstream, remove them first.
    this.pendingEventsRemoved = this.pendingEventsRemoved.filter(this.removeEvent);

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
      oldestTime: this.pendingCurrentTime, // @todo: Cleanup (relayer doesn't care about this).
      firstDepositId,
      latestDepositId,
      searchEndBlock: this.pendingBlockNumber,
      events,
    };
  }
}
