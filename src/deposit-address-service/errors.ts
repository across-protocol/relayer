import { stringifyThrownValue } from "../utils/LogUtils";

/**
 * Typed errors carrying the retry decision, mirroring `src/cctp-finalizer/errors.ts`.
 *
 * `retriable` decides the HTTP response and so whether Pub/Sub redelivers: `false` ⇒ ACK (204), `true` ⇒
 * NACK (500). The choice is constrained by there being **no dead-letter topic** — a NACK retries for as
 * long as the message is retained with nothing to eject it, so `true` must mean "can succeed later",
 * while an ACK discards the message for good.
 *
 * `alert` is `false` everywhere for now, so nothing here reaches `error` level. Set one deliberately
 * once paging destinations are agreed, and keep the list short — everything on it pages.
 */
export abstract class DepositAddressServiceError extends Error {
  abstract readonly retriable: boolean;
  /** Stable machine-readable discriminator, surfaced on the log line. */
  abstract readonly code: string;
  readonly alert: boolean = false;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/** Not a Pub/Sub push delivery at all. Answered 400: no subscription behind it, so no retry loop. */
export class NotAPushRequestError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "NOT_A_PUSH_REQUEST";
}

/** Payload unrecoverable. Does not alert: as likely a probe or hand-rolled request as a producer bug. */
export class UndecodablePushMessageError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "UNDECODABLE_PUSH_MESSAGE";
}

/**
 * `express.json()` rejected the body before any route ran — bad JSON, or over the size cap.
 * Deterministic, so ACK; Express's own non-2xx would redeliver forever without a DLQ.
 */
export class MalformedRequestBodyError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "MALFORMED_REQUEST_BODY";
}

/**
 * Decoded but breaks the message contract. Deterministic, so ACK — and the strongest candidate to alert
 * once paging is agreed, since the message is discarded and the breakage is otherwise log-only.
 */
export class MessageValidationError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "MESSAGE_VALIDATION_FAILED";
}

/** Well-formed but not ours to act on — unsupported `version`, or a classification with no route. */
export class UnsupportedMessageError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "UNSUPPORTED_MESSAGE";
}

/**
 * Execution is off, or no handler is configured. NACK, so nothing is discarded while intentionally idle
 * — which means a disabled service should be **unsubscribed**, not left subscribed and NACKing.
 */
export class ExecutionDisabledError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "EXECUTION_DISABLED";
}

/**
 * A durable state record exists but cannot be decoded. Distinct from an ordinary dependency failure:
 * deterministic, and it clears only when an operator repairs or deletes the key. Still retriable, so the
 * message is preserved and the transfer stays blocked — a record we cannot read may describe a transfer
 * already swept.
 */
export class CorruptTransferStateError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "CORRUPT_TRANSFER_STATE";
}

/**
 * A critical write was not acknowledged by Redis. Retriable, and it must stop the caller: awaiting a
 * confirmation while believing a broadcast hash is durable is the one unrecoverable direction.
 */
export class StatePersistenceError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "STATE_PERSISTENCE_FAILED";
}

/**
 * A transition that would lose funds-safety information — writing `broadcast_pending` over a terminal
 * outcome. Retriable so nothing is discarded, but it means a caller reached a write without the state
 * read that every path is supposed to begin with.
 */
export class IllegalStateTransitionError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "ILLEGAL_STATE_TRANSITION";
}

/**
 * The application deadline passed before a fund-moving step could start. NACK: a redelivery gets a fresh
 * budget, and refusing late is what keeps the un-renewed lock safe.
 */
export class DeadlineExceededError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "APPLICATION_DEADLINE_EXCEEDED";
}

/**
 * Another consumer holds this transfer's lock, or ours lapsed before the point of no return. NACK: the other
 * consumer will finish or its lock will expire, and either way a later delivery can proceed.
 */
export class LockContentionError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "LOCK_CONTENTION";
}

/**
 * The v3 refund-withdraw path is off (`ENABLE_V3_WITHDRAWALS` unset). NACK, same shape as
 * {@link ExecutionDisabledError}: the gate is an operator switch, the funds are still on the deposit
 * address, and an ACK would discard the only delivery that could ever refund them.
 */
export class WithdrawalsDisabledError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "V3_WITHDRAWALS_DISABLED";
}

/**
 * The message carries no usable withdraw leaf in `counterfactualMaterials`. Deterministic — the leaves
 * were fixed when the deposit address was created — so ACK; no redelivery can grow one.
 */
export class MissingWithdrawMaterialsError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "MISSING_WITHDRAW_MATERIALS";
}

/**
 * The sign-withdraw response failed validation — signed for a different chain than the refund chain, or a
 * signature deadline too close to expiry. NACK, like {@link InvalidExecuteResponseError}: the calldata is
 * perishable, so a fresh response on the next delivery may well pass.
 */
export class InvalidWithdrawResponseError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "INVALID_WITHDRAW_RESPONSE";
}

/**
 * The withdrawal settled on-chain but its `withdraw_executed` announcement could not be published. NACK, and
 * the redelivery retries **the publication only** — `withdraw_executed` is preserved, so no path re-withdraws.
 *
 * Its own code rather than {@link TransientDependencyError}'s: the dispositions coincide, but the conditions
 * do not. This one means the funds have already moved and the indexer has not been told, which is the state an
 * operator needs to be able to find on the outcome line. The polling bot instead swallows this failure and
 * logs it, so a dropped publish is never replayed; that is the gap this service closes.
 */
export class WithdrawPublicationError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "WITHDRAW_PUBLICATION_FAILED";
}

/**
 * The origin chain's family has no v3 execute path at all — not EVM, not TVM. ACK: this is a property of the
 * code, not of configuration, so no redelivery can change it while this build is deployed.
 */
export class UnsupportedChainFamilyError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "UNSUPPORTED_CHAIN_FAMILY";
}

/**
 * The origin chain is absent from `RELAYER_ORIGIN_CHAINS`. **NACK, unlike an unsupported family** — this is an
 * operator switch, so the transfer becomes executable again the moment the chain is re-enabled, and ACKing
 * would destroy the only delivery for funds that are still sitting on the deposit address.
 *
 * The polling bot simply skipped and revisited the row on its next poll, so ACKing here would be a parity
 * regression rather than a design choice. Same shape as {@link ExecutionDisabledError}, and the same
 * corollary: a chain disabled for long enough should stop being *published* to this service, not be
 * published and then retried.
 */
export class OriginChainDisabledError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "ORIGIN_CHAIN_DISABLED";
}

/**
 * A namespace that is not native to the origin chain's family (e.g. `tron` on an EVM chain). A data
 * anomaly, deterministic, so ACK. Note zkSync-family chains are EVM here, so a `zksync`-namespaced message
 * is dropped — the same outcome the polling bot produces. The withdraw path raises this more strictly:
 * v3 withdrawals are EVM-only, so even a chain-native `tron` namespace fails there.
 */
export class UnsupportedNamespaceError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "UNSUPPORTED_NAMESPACE";
}

/**
 * Missing or malformed `integratorId`. ACK, because guessing one would derive — and execute at — a
 * different, unfunded address, and no funded v3 address exists that predates the integrator.
 */
export class InvalidIntegratorIdError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "INVALID_INTEGRATOR_ID";
}

/**
 * The funding transfer is no longer canonical: its receipt exists but at a different block than the message
 * claims. Deterministic — a reorged transfer does not come back — so ACK.
 *
 * An *absent* receipt is deliberately not this error: it cannot be told apart from our RPC lagging the
 * indexer, and re-reading a receipt is harmless, so that case raises {@link TransientDependencyError}.
 */
export class NonCanonicalTransferError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "NON_CANONICAL_TRANSFER";
}

/**
 * The deposit address does not hold enough of the input token. **ACK, deliberately**: the balance may never
 * recover, and without a dead-letter topic a NACK would retry every 60s for the whole retention period with
 * nothing to eject it.
 *
 * The usual objection — that our RPC might merely lag the indexer — is handled by ordering, not by retrying:
 * the canonicality guard runs first and NACKs when the funding receipt is not yet visible. So reaching here
 * means the funds genuinely left the address.
 */
export class InsufficientBalanceError extends DepositAddressServiceError {
  readonly retriable = false;
  readonly code = "INSUFFICIENT_BALANCE";
}

/**
 * The execute response failed validation — re-derived address mismatch, wrong chain or ecosystem,
 * placeholder derivation, or a signature deadline too close to expiry. NACK: the calldata is perishable, so
 * a fresh response on the next delivery may well pass.
 */
export class InvalidExecuteResponseError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "INVALID_EXECUTE_RESPONSE";
}

/**
 * A broadcast transaction reverted on-chain. NACK: nothing moved, the `broadcast_pending` record has been
 * cleared, and a later delivery may succeed against different state.
 */
export class BroadcastRevertedError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "BROADCAST_REVERTED";
}

/**
 * The chain has not said what became of a broadcast transaction, so its `broadcast_pending` record is
 * **retained** and the transfer stays blocked. NACK; a later delivery looks again.
 *
 * "Unresolved" is a statement about our knowledge, not about the transaction: it may be unmined, dropped,
 * replaced at its nonce, already mined behind a lagging RPC node, or reorged out. Those are treated
 * identically because retaining is safe in all of them and clearing is unrecoverable in some — the funds may
 * already have moved.
 */
export class UnresolvedBroadcastError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "UNRESOLVED_BROADCAST";
}

/** RPC error, quote-api timeout or 5xx, Redis unavailable — may clear on its own, so NACK. */
export class TransientDependencyError extends DepositAddressServiceError {
  readonly retriable = true;
  readonly code = "TRANSIENT_DEPENDENCY_FAILURE";

  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
  }
}

/**
 * `stringifyThrownValue` throws on a non-`Error` carrying circular references — it guards its `Error`
 * branch and not its non-`Error` one. Every diagnostic path here runs while handling a failure, so a
 * throw would replace the real cause with a serialization `TypeError`: on the route path the intended
 * 500 is never sent, and in the fatal handlers the page describes the serializer instead of what
 * actually went wrong. Shared so the two call sites cannot drift apart again.
 */
export function safeStringifyThrownValue(value: unknown): string {
  try {
    return stringifyThrownValue(value);
  } catch {
    return `<unserializable ${typeof value}>`;
  }
}

export function isDepositAddressServiceError(err: unknown): err is DepositAddressServiceError {
  return err instanceof DepositAddressServiceError;
}

/**
 * Unrecognised errors default to **retriable**, matching `src/cctp-finalizer`: preserving the message is
 * the recoverable direction to fail in when funds are involved.
 */
export function isRetriable(err: unknown): boolean {
  return isDepositAddressServiceError(err) ? err.retriable : true;
}

/**
 * Every typed error answers `false`. An **unrecognised** throw answers `true` — the one case where
 * silence is worse than noise. Giving it a typed error turns the alert off.
 */
export function shouldAlert(err: unknown): boolean {
  return isDepositAddressServiceError(err) ? err.alert : true;
}

export function errorCode(err: unknown): string {
  return isDepositAddressServiceError(err) ? err.code : "UNEXPECTED_ERROR";
}
