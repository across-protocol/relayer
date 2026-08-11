import { PushDelivery } from "../messaging/gcp";
import { DeadlineExceededError, ExecutionDisabledError } from "./errors";

/**
 * Everything one delivery needs, and nothing process-scoped.
 *
 * `logger`, config and the shared clients are deliberately absent: a handler closes over them at
 * construction, so a Cloud Run instance builds one `TransactionClient` rather than one per request.
 * That is not tidiness — the nonce cache lives on the client, so a per-request client would turn the
 * accepted nonce race into a guaranteed one.
 *
 * The deadline is absolute and created once at the HTTP boundary, so every layer reads the same instant
 * instead of recomputing "when did we start" from a duration.
 */
export interface RequestContext {
  readonly delivery: PushDelivery;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

/**
 * `outcome` is a short, stable label to group a dashboard by (`deposit_executed`, `already_executed`).
 * `fields` is anything else worth putting on the log line — delivery identity is added by the app and
 * wins on conflict, so a handler cannot rewrite it. Failure is signalled by throwing a typed error, so
 * the retry decision comes from the error rather than a flag a caller could set wrongly.
 */
export interface HandlerResult {
  readonly outcome: string;
  readonly fields?: Record<string, unknown>;
}

/** Processes one delivery. Constructed once with its dependencies; called once per request. */
export type MessageHandler = (request: RequestContext) => Promise<HandlerResult>;

/**
 * Throw-if-late guard for the point of no return. Call immediately before broadcasting: the deadline,
 * not the Cloud Run request timeout, is what makes the un-renewed Redis lock safe, because a Cloud Run
 * 504 does not stop handler code. Retriable, so a redelivery gets a fresh budget.
 */
export function assertBeforeDeadline(context: RequestContext): void {
  if (context.signal.aborted || Date.now() >= context.deadlineAtMs) {
    throw new DeadlineExceededError("application deadline passed; refusing to proceed");
  }
}

/**
 * Default for builds with no execution logic. **Refuses rather than acknowledging**: a shell that ACKed
 * would silently discard real transfers if a subscription were attached. Replaced via
 * `createApp({ handler })`.
 */
export const unconfiguredHandler: MessageHandler = async () => {
  throw new ExecutionDisabledError("no execution handler is configured in this build");
};
