import { randomUUID } from "crypto";
import { Infer, create, enums, integer, literal, min, string, type, union } from "superstruct";
import { RedisCacheInterface } from "../cache/Redis";
import { TransactionReceipt } from "../utils";
import { isDefined } from "../utils/TypeGuards";
import { CorruptTransferStateError, IllegalStateTransitionError, StatePersistenceError } from "./errors";

/** Long enough that a dead consumer's lock lapses, short enough that the transfer is not stuck for long. */
const LOCK_TTL_MS = 600_000;

/** Beyond the 31-day Pub/Sub retention, so a replayed message cannot outlive the record saying it is done. */
const TERMINAL_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Milliseconds, matching `RequestContext`. Seconds elsewhere in the repo is a trap worth not repeating. */
const timestampMs = () => min(integer(), 0);

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

const WithdrawFailed = type({
  status: literal("withdraw_failed"),
  code: enums(["GAS_EXCEEDS_REFUND", "UNPRICEABLE_REFUND_TOKEN"]),
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
    const acquired = await this.redis.acquireLock(this.lockKey(transferId), token, LOCK_TTL_MS);
    if (!acquired) {
      return undefined;
    }

    // Token-checked, so a lapsed attempt cannot delete the lock a later one now holds.
    return { transferId, release: () => this.redis.releaseLock(this.lockKey(transferId), token) };
  }

  /**
   * Present-but-unparseable throws rather than reading as absent: a record we cannot decode may well
   * describe a transfer already swept, so the transfer stays blocked until someone looks.
   */
  async read(transferId: string): Promise<TransferState | undefined> {
    const raw = await this.redis.get<string>(this.stateKey(transferId));
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

  /** Written once the outcome is known. The polling bot's executed set, per transfer. */
  async recordTerminal(transferId: string, terminal: TerminalState): Promise<void> {
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

    await this.redis.del(this.stateKey(transferId));
    return true;
  }

  /**
   * Every state write goes through here, and an unacknowledged one throws. `set` can answer `undefined`,
   * and a caller that proceeded to await confirmation would believe a hash was durable when it was not.
   */
  private async write(transferId: string, state: TransferState, expirySeconds: number): Promise<void> {
    const reply = await this.redis.set(this.stateKey(transferId), JSON.stringify(state), expirySeconds);
    if (reply !== "OK") {
      throw new StatePersistenceError(
        `redis did not acknowledge ${state.status} for ${transferId} (replied ${JSON.stringify(reply)})`
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
