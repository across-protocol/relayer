import winston from "winston";
import { PubSubPushMessage } from "../messaging/gcp";
import { DepositAddressServiceConfig } from "./config";
import { ExecutionDisabledError } from "./errors";

/**
 * `outcome` is a short, stable label to group a dashboard by (`deposit_executed`, `already_executed`).
 * `fields` is anything else worth putting on the log line. Failure is signalled by throwing a typed
 * error, so the retry decision comes from the error rather than a flag a caller could set wrongly.
 */
export interface HandlerResult {
  readonly outcome: string;
  readonly fields?: Record<string, unknown>;
}

/**
 * Processes one decoded indexer message. Injected so the HTTP layer is testable without execution
 * logic, and so later PRs can replace it without touching routing.
 *
 * @param payload The decoded message body — the item `GET /deposit-address-transfers` serves.
 * @param config **The handler must bound its own work by `applicationDeadlineMs`** and not broadcast
 *   past it. That rule, not the Cloud Run timeout, is what makes the un-renewed Redis lock safe.
 * @param message The whole push body, so a handler can reach delivery metadata without the app
 *   anticipating which parts it needs.
 * @param logger For constructing the shared clients, which all take one. Prefer enriching `fields`
 *   over logging here — the app already writes one line per message.
 */
export type MessageHandler = (
  payload: string,
  config: DepositAddressServiceConfig,
  message: PubSubPushMessage,
  logger: winston.Logger
) => Promise<HandlerResult>;

/**
 * Default for builds with no execution logic. **Refuses rather than acknowledging**: a shell that ACKed
 * would silently discard real transfers if a subscription were attached. Replaced via
 * `createApp({ handler })`.
 */
export const unconfiguredHandler: MessageHandler = async () => {
  throw new ExecutionDisabledError("no execution handler is configured in this build");
};
