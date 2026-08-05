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
 * `express.json()` rejected the body before any route ran — bad JSON, or over `JSON_BODY_LIMIT`.
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
