import assert from "assert";
import { ChildProcess, spawn } from "child_process";
import { Contract, Event } from "ethers";
import { clients, utils as sdkUtils } from "@across-protocol/sdk";
import { CHAIN_MAX_BLOCK_LOOKBACK, RELAYER_DEFAULT_SPOKEPOOL_INDEXER } from "../common/Constants";
import { EventSearchConfig, getNetworkName, isDefined, MakeOptional, winston } from "../utils";
import { EventsAddedMessage, EventRemovedMessage } from "../utils/SuperstructUtils";

export type SpokePoolClient = clients.SpokePoolClient;

export type IndexerOpts = {
  finality: number;
  path?: string;
};

type SpokePoolEventRemoved = {
  event: string;
};

type SpokePoolEventsAdded = {
  blockNumber: number;
  currentTime: number;
  oldestTime: number;
  nEvents: number; // Number of events.
  data: string;
};

export type SpokePoolClientMessage = SpokePoolEventsAdded | SpokePoolEventRemoved;

export function isSpokePoolEventsAdded(message: unknown): message is SpokePoolEventsAdded {
  return EventsAddedMessage.is(message);
}

export function isSpokePoolEventRemoved(message: unknown): message is SpokePoolEventRemoved {
  return EventRemovedMessage.is(message);
}

export class IndexedSpokePoolClient extends clients.SpokePoolClient {
  public readonly chain: string;
  public readonly finality: number;
  public readonly indexerPath: string;

  private worker: ChildProcess;
  private pendingBlockNumber: number;
  private pendingCurrentTime: number;
  private pendingOldestTime: number;

  private pendingEvents: Event[][];
  private pendingEventsRemoved: Event[];

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    readonly hubPoolClient: clients.HubPoolClient | null,
    readonly chainId: number,
    public deploymentBlock: number,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = {
      fromBlock: deploymentBlock,
      maxBlockLookBack: CHAIN_MAX_BLOCK_LOOKBACK[chainId],
    },
    readonly opts: IndexerOpts
  ) {
    super(logger, spokePool, hubPoolClient, chainId, deploymentBlock, eventSearchConfig);

    this.chain = getNetworkName(chainId);
    this.finality = opts.finality;
    this.indexerPath = opts.path ?? RELAYER_DEFAULT_SPOKEPOOL_INDEXER;

    this.pendingBlockNumber = deploymentBlock;
    this.pendingCurrentTime = 0;
    this.pendingEvents = this.queryableEventNames.map(() => []);
    this.pendingEventsRemoved = [];

    this.startWorker();
  }

  /**
   * Fork a child process to independently scrape events.
   * @returns void
   */
  protected startWorker(): void {
    const {
      finality,
      eventSearchConfig: { fromBlock, maxBlockLookBack: blockRange },
    } = this;
    const opts = { finality, blockRange, lookback: `@${fromBlock}` };

    const args = Object.entries(opts)
      .map(([k, v]) => [`--${k}`, `${v}`])
      .flat();
    this.worker = spawn("node", [this.indexerPath, "--chainId", this.chainId.toString(), ...args], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    this.worker.on("message", (message) => this.indexerUpdate(message));
    this.logger.debug({
      at: "SpokePoolClient#startWorker",
      message: `Spawned ${this.chain} SpokePool indexer.`,
      args: this.worker.spawnargs,
    });
  }

  /**
   * Receive an update from the external indexer process.
   * @param rawMessage Message to be parsed.
   * @returns void
   */
  protected indexerUpdate(rawMessage: unknown): void {
    assert(typeof rawMessage === "string", `Unexpected ${this.chain} message data type`);

    const message = JSON.parse(rawMessage);
    if (isSpokePoolEventRemoved(message)) {
      const event = JSON.parse(message.event, sdkUtils.jsonReviverWithBigNumbers);
      this.pendingEventsRemoved.push(event);
      return;
    }

    assert(isSpokePoolEventsAdded(message), `Expected ${this.chain} SpokePoolEventsAdded message`);

    const { blockNumber, currentTime, oldestTime, nEvents, data } = message;
    if (nEvents > 0) {
      const pendingEvents = JSON.parse(data, sdkUtils.jsonReviverWithBigNumbers);
      assert(
        Array.isArray(pendingEvents) && pendingEvents.length === nEvents,
        Array.isArray(pendingEvents)
          ? `Expected ${nEvents} ${this.chain} pendingEvents, got ${pendingEvents.length}`
          : `Expected array of ${this.chain} pendingEvents`
      );

      this.logger.debug({
        at: "SpokePoolClient#indexerUpdate",
        message: `Received ${nEvents} ${this.chain} events from indexer.`,
      });

      pendingEvents.forEach((event) => {
        const eventIdx = this.queryableEventNames.indexOf(event.event);
        assert(
          eventIdx !== -1 && event.removed === false,
          event.removed ? "Incorrectly received removed event" : `Unsupported event name (${event.event})`
        );

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
  protected removeEvent(event: Event): boolean {
    let removed = false;
    const eventIdx = this.queryableEventNames.indexOf(event.event);
    const pendingEvents = this.pendingEvents[eventIdx];

    const { event: eventName, blockNumber, blockHash, transactionHash, transactionIndex, logIndex } = event;

    // First check for removal from any pending events.
    const pendingEventIdx = pendingEvents.findIndex(
      (pending) =>
        pending.logIndex === logIndex &&
        pending.transactionIndex === transactionIndex &&
        pending.transactionHash === transactionHash &&
        pending.blockHash === blockHash
    );

    if (pendingEventIdx !== -1) {
      removed = true;

      // Drop the relevant event.
      pendingEvents.splice(pendingEventIdx, 1);

      this.logger.debug({
        at: "SpokePoolClient#removeEvent",
        message: `Removed ${this.chain} ${eventName} event for block ${blockNumber}.`,
        event,
      });
    }

    // Back out any events that were previously ingested via update(). This is best-effort and may help to save the
    // relayer from filling a deposit where it must wait for additional deposit confirmations. Note that this is
    // _unsafe_ to do ad-hoc, since it may interfere with some ongoing relayer computations relying on the
    // depositHashes object. If that's an acceptable risk then it might be preferable to simply assert().
    if (eventName === "V3FundsDeposited") {
      const { depositId } = event.args;
      assert(isDefined(depositId));

      const depositHash = this.getDepositHash({ depositId, originChainId: this.chainId });
      if (isDefined(this.depositHashes[depositHash])) {
        delete this.depositHashes[depositHash];
        this.logger.warn({
          at: "SpokePoolClient#removeEvent",
          message: `Removed 1 pre-ingested ${this.chain} ${eventName} event.`,
          event,
        });
      }
    } else if (eventName === "EnabledDepositRoute") {
      // These are hard to back out because they're not stored with transaction information. They should be extremely
      // rare, but at the margins could risk making an invalid fill based on the resolved outputToken for a deposit
      // that specifies outputToken 0x0. Simply bail in this case; everything should be OK on the next run.
      throw new Error("Detected re-org affecting deposit route events.");
    } else {
      // Retaining any remaining event types should be non-critical for relayer operation. They may
      // produce sub-optimal decisions, but should not affect the correctness of relayer operation.
      this.logger.debug({
        at: "SpokePoolClient#removeEvent",
        message: `Detected re-org affecting pre-ingested ${this.chain} ${eventName} events. Ignoring.`,
        transactionHash,
        blockHash,
      });
    }

    return removed;
  }

  protected async _update(eventsToQuery: string[]): Promise<clients.SpokePoolUpdate> {
    // If any events have been removed upstream, remove them first.
    this.pendingEventsRemoved = this.pendingEventsRemoved.filter((event) => !this.removeEvent(event));

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
