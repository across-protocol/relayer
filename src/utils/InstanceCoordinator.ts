import { delay, isDefined, winston } from "./";
import { RedisCacheInterface } from "../cache/Redis";

// Lifetime of the drained signal. Only consumed by the immediate successor (which matches the
// signal against the specific predecessor it took over from), so it just needs to outlive the
// takeover wait; match the instance lease for symmetry.
const DRAINED_SIGNAL_EXPIRY = 1200;

export class InstanceCoordinator {
  constructor(
    private readonly logger: winston.Logger,
    private readonly redis: RedisCacheInterface,
    public readonly identifier: string,
    public readonly instance: string,
    private readonly abortController: AbortController,
    public readonly instanceExpiry = 1200
  ) {}

  private getDrainedKey(): string {
    return `${this.identifier}:drained`;
  }

  async getActiveInstance(): Promise<string | undefined> {
    return (await this.redis.get<string>(this.identifier)) ?? undefined;
  }

  setActiveInstance(): Promise<string | undefined> {
    return this.redis.set(this.identifier, this.instance, this.instanceExpiry);
  }

  async isActiveInstance(): Promise<boolean> {
    return (await this.getActiveInstance()) === this.instance;
  }

  /**
   * Takes over as the active instance. Returns the previously-active instance (undefined on a
   * cold start / expired lease) so the caller can wait for its drained signal via
   * waitForPredecessorDrain before starting work of its own.
   */
  async initiateHandover(): Promise<string | undefined> {
    const activeInstance = await this.getActiveInstance();
    this.logger.debug({
      at: "Coordinator::initiateHandover",
      message: `Taking over from ${this.identifier} instance ${activeInstance}.`,
    });

    await this.setActiveInstance();
    return activeInstance;
  }

  /**
   * Signals that this instance has finished draining in-flight work after ceding (or on
   * shutdown). The successor blocks on this signal in waitForPredecessorDrain, so it must only
   * be emitted once all in-flight executions have settled and their state is persisted.
   */
  async signalDrained(): Promise<void> {
    await this.redis.set(this.getDrainedKey(), this.instance, DRAINED_SIGNAL_EXPIRY);
    this.logger.debug({
      at: "Coordinator::signalDrained",
      message: `Signalled drained for ${this.identifier} instance ${this.instance}.`,
    });
  }

  /**
   * Waits until `predecessor` (the instance returned by initiateHandover) signals it has drained
   * its in-flight work, so this instance does not act on state the predecessor is still writing.
   * Resolves true when the signal is observed; false on timeout, abort, or sustained Redis
   * errors — callers should proceed in that case (the predecessor may have crashed) and rely on
   * per-execution guards for anything it left in flight. Returns immediately when there is no
   * predecessor (cold start).
   */
  async waitForPredecessorDrain(predecessor: string | undefined, timeoutSeconds: number): Promise<boolean> {
    if (!isDefined(predecessor) || predecessor === this.instance) {
      return true;
    }

    const maxConsecutiveErrors = 10;
    let consecutiveErrors = 0;
    const deadline = Date.now() + timeoutSeconds * 1000;
    do {
      try {
        if ((await this.redis.get<string>(this.getDrainedKey())) === predecessor) {
          this.logger.debug({
            at: "Coordinator::waitForPredecessorDrain",
            message: `Predecessor ${this.identifier} instance ${predecessor} signalled drained.`,
          });
          return true;
        }
        consecutiveErrors = 0;
      } catch (err) {
        if (++consecutiveErrors >= maxConsecutiveErrors) {
          this.logger.error({
            at: "Coordinator::waitForPredecessorDrain",
            message: "Redis unreachable while waiting for predecessor drain; proceeding.",
            err: String(err),
          });
          return false;
        }
      }
      if (Date.now() >= deadline || this.abortController.signal.aborted) {
        break;
      }
      await delay(1);
    } while (!this.abortController.signal.aborted);

    return false;
  }

  // Poor-man's subscription - just poll on a 1s interval.
  async subscribe(): Promise<string | undefined> {
    const maxConsecutiveErrors = 10;
    let consecutiveErrors = 0;
    let activeInstance: string | undefined = this.instance;
    do {
      await delay(1);
      if (this.abortController.signal.aborted) {
        break;
      }

      try {
        activeInstance = (await this.redis.get<string>(this.identifier)) ?? undefined;
        consecutiveErrors = 0;
      } catch (err) {
        if (++consecutiveErrors >= maxConsecutiveErrors) {
          this.logger.error({
            at: "Coordinator::subscribe",
            message: "Redis unreachable; exiting.",
            err: String(err),
          });
          break;
        }
      }
    } while (activeInstance === this.instance);

    if (activeInstance !== this.instance) {
      this.logger.debug({
        at: "Coordinator::monitorInstance",
        message: `Handover requested by ${this.identifier} instance ${activeInstance}.`,
      });
    }

    return activeInstance ?? undefined;
  }
}
