import assert from "assert";
import { ChildProcess, spawn } from "child_process";
import { clients, utils as sdkUtils } from "@across-protocol/sdk";
import { Log, DepositWithBlock } from "../interfaces";
import { RELAYER_SPOKEPOOL_LISTENER_EVM, RELAYER_SPOKEPOOL_LISTENER_SVM } from "../common/Constants";
import { Address, chainIsSvm, getNetworkName, isDefined, winston, spreadEventWithBlockNumber } from "../utils";
import { EventsAddedMessage, EventRemovedMessage } from "../utils/SuperstructUtils";

export type SpokePoolClient = clients.SpokePoolClient;

export type IndexerOpts = {
  path?: string;
};

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

/**
 * Apply Typescript Mixins to permit a single class to generically extend a SpokePoolClient-ish instance.
 * The SDK exports both the EVMSpokePoolClient and SVMSpokePoolClient types. They have different properties
 * and even different methods of instantiation. To avoid duplicating the SpokePoolListener implementation,
 * provide the minimal common definition of a SpokePoolClient and extend that. This doesn't necessarily feel
 * like a long-term solution, but it's OK for now and only imposes the absolute minimum of changes upstream
 * in the SDK. The external listener implementation should ultimately be upstreamed to the SDK, but that's
 * more invasive and out of scope for now.
 * Reference: https://www.typescriptlang.org/docs/handbook/mixins.html
 */
type Constructor<T = Record<string, unknown>> = new (...args: any[]) => T;

// Minimum common-ish interface supplied by the SpokePoolClient.
type MinGenericSpokePoolClient = {
  chainId: number;
  spokePoolAddress: Address | undefined;
  deploymentBlock: number;
  _queryableEventNames: () => string[];
  eventSearchConfig: { from: number; to?: number; maxLookBack?: number };
  depositHashes: { [depositHash: string]: DepositWithBlock };
  logger: winston.Logger;
};

export function SpokeListener<T extends Constructor<MinGenericSpokePoolClient>>(SpokePoolClient: T) {
  return class extends SpokePoolClient {
    // Standard private/readonly constraints are not available to mixins; use ES2020 private properties instead.
    #chain: string;
    #indexerPath: string;

    #worker: ChildProcess;
    #pendingBlockNumber: number;
    #pendingCurrentTime: number;

    #pendingEvents: Log[][];
    #pendingEventsRemoved: Log[];

    init(opts: IndexerOpts) {
      this.#chain = getNetworkName(this.chainId);
      this.#indexerPath = opts.path;
      this.#indexerPath ??= chainIsSvm(this.chainId) ? RELAYER_SPOKEPOOL_LISTENER_SVM : RELAYER_SPOKEPOOL_LISTENER_EVM;

      this.#pendingBlockNumber = this.deploymentBlock;
      this.#pendingCurrentTime = 0;
      this.#pendingEvents = this._queryableEventNames().map(() => []);
      this.#pendingEventsRemoved = [];

      this._startWorker();
    }

    /**
     * Fork a child process to independently scrape events.
     * @returns void
     */
    _startWorker(): void {
      const {
        eventSearchConfig: { from, maxLookBack: blockrange },
        spokePoolAddress: spokepool,
      } = this;
      const opts = { spokepool: spokepool.toNative(), blockrange, lookback: `@${from}` };

      const args = Object.entries(opts)
        .map(([k, v]) => [`--${k}`, `${v}`])
        .flat();
      this.#worker = spawn("node", [this.#indexerPath, "--chainid", this.chainId.toString(), ...args], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });

      this.#worker.on("exit", (code, signal) => this.#childExit(code, signal));
      this.#worker.on("message", (message) => this._indexerUpdate(message));
      this.logger.debug({
        at: "SpokePoolClient#startWorker",
        message: `Spawned ${this.#chain} SpokePool indexer.`,
        args: this.#worker.spawnargs,
      });
    }

    stopWorker(): void {
      const at = "SpokePoolClient#stopWorker";

      if (this.#worker.connected) {
        this.#worker.disconnect();
      } else {
        const message = `Skipped disconnecting on ${this.#chain} SpokePool listener (already disconnected).`;
        this.logger.warn({ at, message });
      }

      const { exitCode } = this.#worker;
      if (exitCode === null) {
        this.#worker.kill("SIGKILL");
      } else {
        const message = `Skipped SIGKILL on ${this.#chain} SpokePool listener (already exited).`;
        this.logger.warn({ at, message, exitCode });
      }
    }

    /**
     * The worker process has exited. Future: Optionally restart it based on the exit code.
     * See also: https://nodejs.org/api/child_process.html#event-exit
     * @param code Optional exit code.
     * @param signal Optional signal resulting in termination.
     * @returns void
     */
    #childExit(code?: number, signal?: string): void {
      const at = "SpokePoolClient#childExit";
      if (code === 0) {
        return;
      }

      const log = signal === "SIGKILL" ? this.logger.debug : this.logger.warn;
      log({ at, message: `${this.#chain} SpokePool listener exited.`, code, signal });
    }

    /**
     * Receive an update from the external indexer process.
     * @param rawMessage Message to be parsed.
     * @returns void
     */
    _indexerUpdate(rawMessage: unknown): void {
      const at = "SpokePoolClient#indexerUpdate";
      assert(typeof rawMessage === "string", `Unexpected ${this.#chain} message data type (${typeof rawMessage})`);

      const message = JSON.parse(rawMessage);
      if (EventRemovedMessage.is(message)) {
        const event = JSON.parse(message.event, sdkUtils.jsonReviverWithBigNumbers);
        this.#pendingEventsRemoved.push(event);
        return;
      }

      if (!EventsAddedMessage.is(message)) {
        this.logger.warn({ at, message: "Received unexpected message from SpokePoolListener.", rawMessage: message });
        return;
      }

      const { blockNumber, currentTime, nEvents, data } = message;
      if (nEvents > 0) {
        const pendingEvents = JSON.parse(data, sdkUtils.jsonReviverWithBigNumbers);

        assert(Array.isArray(pendingEvents), `Expected array of ${this.#chain} pendingEvents`);
        const nPending = pendingEvents.length;
        assert(nPending === nEvents, `Expected ${nEvents} ${this.#chain} pendingEvents, got ${nPending}`);

        this.logger.debug({ at, message: `Received ${nEvents} ${this.#chain} events from indexer.` });

        pendingEvents.forEach((event) => {
          const eventIdx = this._queryableEventNames().indexOf(event.event);
          assert(
            eventIdx !== -1 && event.removed === false,
            event.removed ? "Incorrectly received removed event" : `Unsupported event name (${event.event})`
          );

          this.#pendingEvents[eventIdx].push(event);
        });
      }

      this.#pendingBlockNumber = blockNumber;
      this.#pendingCurrentTime = currentTime;
    }

    /**
     * Given an event to be removed, ensure that it is removed from the set of ingested events.
     * @param event An Ethers event instance.
     * @returns void
     */
    #removeEvent(event: Log): boolean {
      const at = "SpokePoolClient#removeEvent";
      const eventIdx = this._queryableEventNames().indexOf(event.event);
      const pendingEvents = this.#pendingEvents[eventIdx];
      const { event: eventName, blockNumber, blockHash, transactionHash, transactionIndex, logIndex } = event;

      // First check for removal from any pending events.
      const pendingEventIdx = pendingEvents.findIndex(
        (pending) =>
          pending.logIndex === logIndex &&
          pending.transactionIndex === transactionIndex &&
          pending.transactionHash === transactionHash &&
          pending.blockHash === blockHash
      );

      let handled = false;
      if (pendingEventIdx !== -1) {
        // Drop the relevant event.
        pendingEvents.splice(pendingEventIdx, 1);
        handled = true;

        this.logger.debug({
          at: "SpokePoolClient#removeEvent",
          message: `Removed 1 pre-ingested ${this.#chain} ${eventName} event for block ${blockNumber}.`,
          event,
        });
      }

      // Back out any events that were previously ingested via update(). This is best-effort and may help to save the
      // relayer from filling a deposit where it must wait for additional deposit confirmations. Note that this is
      // _unsafe_ to do ad-hoc, since it may interfere with some ongoing relayer computations relying on the
      // depositHashes object. If that's an acceptable risk then it might be preferable to simply assert().
      if (eventName === "FundsDeposited") {
        const { depositId } = event.args;
        assert(isDefined(depositId));

        const result = Object.entries(this.depositHashes).find(([, deposit]) => deposit.txnRef === transactionHash);
        if (isDefined(result)) {
          const [depositKey, deposit] = result;
          delete this.depositHashes[depositKey];
          handled = true;
          this.logger.warn({ at, message: `Removed 1 ${this.#chain} ${eventName} event.`, deposit });
        } else {
          this.logger.warn({
            at,
            message: `Searched for ${this.#chain} deposit ${depositId} but didn't find it.`,
            transactionHash,
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
        handled = true;
        const message = `Detected re-org affecting pre-ingested ${this.#chain} ${eventName} events. Ignoring.`;
        this.logger.debug({ at, message, transactionHash, blockHash });
      }

      return handled;
    }

    async _update(eventsToQuery: string[]): Promise<clients.SpokePoolUpdate> {
      if (this.#pendingBlockNumber === this.deploymentBlock) {
        return { success: false, reason: clients.UpdateFailureReason.NotReady };
      }

      // If any events have been removed upstream, remove them first.
      this.#pendingEventsRemoved = this.#pendingEventsRemoved.filter((event) => !this.#removeEvent(event));

      const events = eventsToQuery.map((eventName) => {
        const eventIdx = this._queryableEventNames().indexOf(eventName);
        assert(eventIdx !== -1);

        const pendingEvents = this.#pendingEvents[eventIdx];
        this.#pendingEvents[eventIdx] = [];

        pendingEvents.forEach(({ removed }) => assert(!removed));
        return pendingEvents.map(spreadEventWithBlockNumber);
      });

      return {
        success: true,
        currentTime: this.#pendingCurrentTime,
        searchEndBlock: this.#pendingBlockNumber,
        events,
      };
    }
  };
}
