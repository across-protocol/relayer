import { randomUUID } from "crypto";
import { Infer, create, enums, integer, literal, min, optional, string, type, union } from "superstruct";
import { RedisCacheInterface } from "../cache/Redis";
import { TransactionReceipt } from "../utils";
import { isDefined } from "../utils/TypeGuards";
import {
  CorruptTransferStateError,
  IllegalStateTransitionError,
  StatePersistenceError,
  TransientDependencyError,
} from "./errors";

/**
 * Long enough that a worker always holds its lock for its whole life, short enough that a transfer is not
 * stuck behind a dead consumer for long.
 *
 * It must cover the application deadline **plus** the confirmation that runs after it:
 * `assertBeforeDeadline` bounds when a broadcast *begins*, so a broadcast starting just inside the 480s
 * deadline still has its confirmation ahead of it. `DepositAddressServiceConfig` asserts
 * `lockTtlMs >= applicationDeadlineMs + confirmBudgetMs` at startup so the two cannot drift apart.
 *
 * Deliberately larger than the 600s Pub/Sub ack deadline (its maximum): a redelivery arriving as Cloud Run
 * returns 504 finds the lock still held, NACKs on contention and backs off, by which time the original has
 * written terminal state.
 */
export const LOCK_TTL_MS = 900_000;

/** Beyond the 31-day Pub/Sub retention, so a replayed message cannot outlive the record saying it is done. */
const TERMINAL_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Milliseconds, matching `RequestContext`. Seconds elsewhere in the repo is a trap worth not repeating. */
const timestampMs = () => min(integer(), 0);

/**
 * Deliberately just the hash, the chain and when.
 *
 * No signer or nonce: nonce management belongs to `TransactionClient`, whose confirmation wait already
 * refuses to resubmit a consumed nonce and re-notifies `onBroadcast` when it replaces a transaction, so the
 * record follows the live hash on its own. Recording them here to second-guess that would buy only one
 * narrow recovery — a worker that died mid-confirm during a nonce collision — and cost a chain-family gate
 * that clears a **live** record if it is ever wrong (TVM reports `nonce: 0` unconditionally).
 */
const BroadcastPending = type({
  status: literal("broadcast_pending"),
  operation: enums(["deposit", "withdraw"]),
  txHash: string(),
  chainId: min(integer(), 1),
  submittedAtMs: timestampMs(),
});

const DepositExecuted = type({
  status: literal("deposit_executed"),
  txHash: string(),
  chainId: min(integer(), 1),
  blockNumber: min(integer(), 0),
  completedAtMs: timestampMs(),
});

/** Separate from `DepositExecuted` because only this one gains lifecycle-publication state (PR 6). */
const WithdrawExecuted = type({
  status: literal("withdraw_executed"),
  txHash: string(),
  chainId: min(integer(), 1),
  blockNumber: min(integer(), 0),
  completedAtMs: timestampMs(),
});

/**
 * `code` is optional because the sign-withdraw client posts through `_postOrThrow`, which discards the API's
 * error code — the handler classifies on the HTTP status alone, exactly as the polling bot does, and records
 * no code. The enum stays for the day that call is switched to `_postOrThrowWithErrorCode` for diagnostics.
 */
const WithdrawFailed = type({
  status: literal("withdraw_failed"),
  code: optional(enums(["GAS_EXCEEDS_REFUND", "UNPRICEABLE_REFUND_TOKEN"])),
  reason: string(),
  recordedAtMs: timestampMs(),
});

const TerminalStateStruct = union([DepositExecuted, WithdrawExecuted, WithdrawFailed]);
const TransferStateStruct = union([BroadcastPending, TerminalStateStruct]);

export type BroadcastPendingState = Infer<typeof BroadcastPending>;
export type TerminalState = Infer<typeof TerminalStateStruct>;
export type TransferState = Infer<typeof TransferStateStruct>;

/** Anything other than `broadcast_pending`: the funds have moved, or will never move. */
export function isTerminal(state: TransferState): state is TerminalState {
  return state.status !== "broadcast_pending";
}

/**
 * Whether `terminal` may replace what is already recorded.
 *
 * A pending record may only be replaced by the outcome of **its own** transaction. The hash comes from
 * the terminal record rather than a parameter, so a mismatched one cannot be passed in. `withdraw_failed`
 * carries no hash and therefore can never replace a pending broadcast — that transaction may still land.
 * An identical outcome is idempotent; a different one is refused.
 *
 * This matters because a worker can outlive its lock: nothing threads the application deadline into
 * `TransactionClient`, whose confirmation wait resubmits with a decrementing `maxTries`, so on mainnet it
 * can occupy a worker for far longer than the 600s lock TTL.
 */
function canReplace(current: TransferState, terminal: TerminalState): boolean {
  if (isTerminal(current)) {
    return current.status === terminal.status;
  }
  return "txHash" in terminal && current.txHash === terminal.txHash;
}

/**
 * What a receipt says about a broadcast transaction. Facts only — whether each means ACK, NACK, clear or
 * persist is retry policy, and belongs with the orchestration that also holds the lock.
 *
 * A receipt with no explicit `status === 0` reads as confirmed: ethers leaves `status` undefined on some
 * chains, and guessing "confirmed" can strand a deposit for manual recovery, whereas guessing "reverted"
 * would re-broadcast one that already landed. Only the first is reversible.
 */
export function classifyReceipt(
  receipt: TransactionReceipt | null | undefined
): "confirmed" | "reverted" | "unresolved" {
  if (!isDefined(receipt) || !isDefined(receipt.blockNumber)) {
    return "unresolved";
  }
  return receipt.status === 0 ? "reverted" : "confirmed";
}

/** Held while a transfer is being worked. The token stays inside, so no caller can supply or reuse one. */
export interface TransferLock {
  readonly transferId: string;
  /**
   * Whether this attempt still owns the lock. Called immediately before broadcasting, since the lock is not
   * renewed: a request that reached the point of no return with a lapsed lock must stop, because another
   * consumer may already be working the same transfer.
   */
  isHeld(): Promise<boolean>;
  release(): Promise<boolean>;
}

/** Only the commands this store issues, so a test fake can `satisfies` it rather than be cast. */
export type TransferStoreRedis = Pick<RedisCacheInterface, "acquireLock" | "releaseLock" | "get" | "set" | "del">;

/**
 * The two Redis keys per transfer.
 *
 * They are separate because their lifetimes are opposites: the **lock** must expire, so a consumer that
 * dies does not block a transfer forever; the **state** must not, because a `broadcast_pending` record
 * has to outlive anything that could still land on-chain. Merging them would reintroduce exactly the
 * problem the design exists to remove.
 *
 * Redis is injected — `getRedisCache` returns `undefined` under `RELAYER_TEST`.
 */
export class TransferStore {
  constructor(private readonly redis: TransferStoreRedis) {}

  /**
   * `SET NX` on the lock key. The only thing stopping two live consumers both passing the pre-broadcast
   * checks — `broadcast_pending` cannot, since it is written after a broadcast, not before.
   *
   * The token is a uuid generated here, per attempt. Uniqueness is all the release check needs, and a
   * message id cannot supply it, because Pub/Sub redelivers the same message.
   *
   * @returns the lock, or `undefined` when another consumer holds it.
   */
  async acquireLock(transferId: string): Promise<TransferLock | undefined> {
    const token = randomUUID();
    const key = this.lockKey(transferId);
    const acquired = await this.command("acquireLock", transferId, () =>
      this.redis.acquireLock(key, token, LOCK_TTL_MS)
    );
    if (!acquired) {
      return undefined;
    }

    // Token-checked, so a lapsed attempt cannot delete the lock a later one now holds.
    return {
      transferId,
      isHeld: async () => (await this.command("get", transferId, () => this.redis.get<string>(key))) === token,
      release: () => this.command("releaseLock", transferId, () => this.redis.releaseLock(key, token)),
    };
  }

  /**
   * Present-but-unparseable throws rather than reading as absent: a record we cannot decode may well
   * describe a transfer already swept, so the transfer stays blocked until someone looks.
   */
  async read(transferId: string): Promise<TransferState | undefined> {
    const raw = await this.command("get", transferId, () => this.redis.get<string>(this.stateKey(transferId)));
    if (!isDefined(raw)) {
      return undefined;
    }

    try {
      return create(JSON.parse(raw), TransferStateStruct);
    } catch (err) {
      throw new CorruptTransferStateError(
        `transfer state for ${transferId} is unreadable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Written the moment a hash exists, before the confirmation wait. Never expires.
   *
   * Refuses to overwrite a terminal outcome — the one transition that would lose funds-safety
   * information. Reaching it means a caller skipped the state read every path begins with.
   */
  async recordBroadcast(transferId: string, pending: Omit<BroadcastPendingState, "status">): Promise<void> {
    const current = await this.read(transferId);
    if (isDefined(current) && isTerminal(current)) {
      throw new IllegalStateTransitionError(
        `refusing to write broadcast_pending over ${current.status} for ${transferId}`
      );
    }

    await this.write(transferId, { status: "broadcast_pending", ...pending }, Number.POSITIVE_INFINITY);
  }

  /**
   * Written once the outcome is known. The polling bot's executed set, per transfer.
   *
   * Refuses anything {@link canReplace} rejects: a worker whose lock lapsed must not write its own
   * transaction's outcome over a newer pending one, and `withdraw_failed` must not erase a broadcast that
   * may still land.
   */
  async recordTerminal(transferId: string, terminal: TerminalState): Promise<void> {
    const current = await this.read(transferId);
    if (isDefined(current) && !canReplace(current, terminal)) {
      throw new IllegalStateTransitionError(
        `refusing to write ${terminal.status} over ${current.status} for ${transferId}`
      );
    }

    await this.write(transferId, terminal, TERMINAL_TTL_SECONDS);
  }

  /**
   * Clears a `broadcast_pending` whose transaction is known to have reverted: nothing moved, so the
   * transfer may be re-attempted.
   *
   * Deletes only if the record is *still* that transaction. A stale reconciliation must not delete a
   * newer pending hash or a terminal outcome — that would unblock a transfer mid-sweep, which is the
   * failure this design exists to prevent. Read-then-delete is sufficient because callers hold the lock;
   * it would need to be atomic only if that stopped being true.
   *
   * @returns whether the record was removed.
   */
  async clearRevertedBroadcast(transferId: string, expectedTxHash: string): Promise<boolean> {
    const current = await this.read(transferId);
    if (!isDefined(current) || isTerminal(current) || current.txHash !== expectedTxHash) {
      return false;
    }

    await this.command("del", transferId, () => this.redis.del(this.stateKey(transferId)));
    return true;
  }

  /**
   * Every state write goes through here, and an unacknowledged one throws. `set` can answer `undefined`,
   * and a caller that proceeded to await confirmation would believe a hash was durable when it was not.
   */
  private async write(transferId: string, state: TransferState, expirySeconds: number): Promise<void> {
    const reply = await this.command("set", transferId, () =>
      this.redis.set(this.stateKey(transferId), JSON.stringify(state), expirySeconds)
    );
    if (reply !== "OK") {
      throw new StatePersistenceError(
        `redis did not acknowledge ${state.status} for ${transferId} (replied ${JSON.stringify(reply)})`
      );
    }
  }

  /**
   * Rejections from Redis become {@link TransientDependencyError}. Without this the raw client error
   * escapes, and since an unrecognised throw is treated as alerting, an ordinary Redis outage would page
   * on every delivery instead of taking the debug-level retry path it belongs on.
   */
  private async command<T>(name: string, transferId: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      throw new TransientDependencyError(
        `redis ${name} failed for ${transferId}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  private lockKey(transferId: string): string {
    return `deposit-address:lock:${transferId}`;
  }

  private stateKey(transferId: string): string {
    return `deposit-address:state:${transferId}`;
  }
}
