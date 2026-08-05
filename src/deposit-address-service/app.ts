import express, { Express, NextFunction, Request, Response } from "express";
import winston from "winston";
import { DepositAddressServiceConfig } from "./config";
import { MessageHandler, unconfiguredHandler } from "./handler";
import { RequestLifecycle } from "./lifecycle";
import {
  ExecutionDisabledError,
  MalformedRequestBodyError,
  NotAPushRequestError,
  UndecodablePushMessageError,
  errorCode,
  isRetriable,
  shouldAlert,
} from "./errors";
import { PubSubPushMessage, decodePubSubData } from "../messaging/gcp";
import { isDefined } from "../utils/TypeGuards";
import { stringifyThrownValue } from "../utils/LogUtils";

const AT = "DepositAddressService#push";

/** Routing key the logger's Slack / PagerDuty / Discord transports use to select a destination. */
const ALERT_NOTIFICATION_PATH = "across-bot-error";

/**
 * Caps the body so a malformed or hostile request cannot be buffered without bound. Indexer items are a
 * few KB, so this is generous.
 *
 * Fixed rather than configurable on purpose: `express.json({ limit })` runs the value through
 * `bytes.parse`, which fails *silently* — `"foo"` yields `null` and removes the cap altogether, while
 * `"100mbb"` yields 100 bytes and rejects everything. A typo in an env var would therefore break the
 * limit in one direction or the other with no startup error.
 */
const JSON_BODY_LIMIT = "1mb";

/**
 * Pub/Sub reads one thing from the response: 2xx acknowledges, anything else redelivers. There is no
 * "permanent failure" status for push subscriptions, which is why a malformed *message* gets 204.
 */
const STATUS = {
  ack: 204,
  nack: 500,
  badRequest: 400,
  draining: 503,
} as const;

export interface AppDependencies {
  logger: winston.Logger;
  config: DepositAddressServiceConfig;
  lifecycle: RequestLifecycle;
  /** Injected so routing is testable without execution logic, and swappable by later PRs. */
  handler?: MessageHandler;
}

/**
 * Caller authentication is not handled here — Cloud Run IAM admits only the push subscription's
 * service account, so a request reaching this app is already authenticated by the platform.
 */
export function createApp(deps: AppDependencies): Express {
  const { logger, config, lifecycle } = deps;
  const handlerConfigured = isDefined(deps.handler);
  const pushDeps: PushHandlerDeps = { logger, config, handler: deps.handler ?? unconfiguredHandler };

  const app = express();
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Liveness stays true while draining, so an instance is not restarted out from under its requests.
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
  });

  // "Would do useful work with a delivery" — false for a shell build.
  app.get("/ready", (_req: Request, res: Response) => {
    const ready = lifecycle.acceptingRequests && config.executionEnabled && handlerConfigured;
    res.status(ready ? 200 : STATUS.draining).json({
      ready,
      inFlight: lifecycle.inFlightCount,
      executionEnabled: config.executionEnabled,
      handlerConfigured,
    });
  });

  app.post("/", async (req: Request, res: Response) => {
    if (!lifecycle.acceptingRequests) {
      res.status(STATUS.draining).send("Draining");
      return;
    }

    const complete = lifecycle.begin();
    try {
      await handlePush(req, res, pushDeps);
    } catch (err) {
      // Express 4 does not handle rejected async route promises: without this boundary an unexpected
      // throw becomes an unhandled rejection and exits the process, losing everything else in flight.
      respondToFailure(res, err, deliveryFields(config, readBody(req)), pushDeps);
    } finally {
      complete();
    }
  });

  // Last, so it catches body-parser failures, which reject before any route runs. Express would
  // otherwise answer its own non-2xx with no log line — and a non-2xx redelivers forever without a DLQ.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logOutcome(logger, {
      fields: { executionEnabled: config.executionEnabled, bodyParserError: (err as { type?: string }).type },
      outcome: "dropped_malformed_request_body",
      ack: true,
      error: new MalformedRequestBodyError(err.message),
    });
    res.status(STATUS.ack).send();
  });

  return app;
}

interface PushHandlerDeps {
  logger: winston.Logger;
  config: DepositAddressServiceConfig;
  handler: MessageHandler;
}

/** `express.json()` leaves `body` undefined on an empty request. */
function readBody(req: Request): PubSubPushMessage {
  return (req.body ?? {}) as PubSubPushMessage;
}

async function handlePush(req: Request, res: Response, deps: PushHandlerDeps): Promise<void> {
  const { logger, config } = deps;
  const body = readBody(req);

  // No `message` means this did not come from Pub/Sub. A 4xx is safe here and only here: there is no
  // subscription behind it, so it cannot become a redelivery loop.
  if (!isDefined(body.message) || typeof body.message !== "object") {
    logOutcome(logger, {
      fields: deliveryFields(config, body),
      outcome: "rejected_not_a_push_request",
      ack: false,
      error: new NotAPushRequestError("Request body has no Pub/Sub `message` object"),
    });
    res.status(STATUS.badRequest).send("Bad Request: not a Pub/Sub push delivery");
    return;
  }

  // ACK, not NACK: with no dead-letter policy a non-2xx would redeliver this forever, and redelivery
  // cannot make an undecodable body decodable.
  const payload = decodePubSubData(body.message.data);
  if (!isDefined(payload)) {
    logOutcome(logger, {
      fields: deliveryFields(config, body),
      outcome: "dropped_undecodable_message",
      ack: true,
      error: new UndecodablePushMessageError("Pub/Sub message `data` is absent, not a string, or empty"),
    });
    res.status(STATUS.ack).send();
    return;
  }

  await runHandler(res, payload, body, deps);
}

async function runHandler(
  res: Response,
  payload: string,
  body: PubSubPushMessage,
  deps: PushHandlerDeps
): Promise<void> {
  const { logger, config, handler } = deps;
  const startedAtMs = Date.now();
  const fields = deliveryFields(config, body);

  // Enforced here, not only in the default handler, so the switch holds for any injected handler.
  // Retriable, so a service disabled by mistake preserves its work rather than discarding it.
  if (!config.executionEnabled) {
    respondToFailure(res, new ExecutionDisabledError("EXECUTION_ENABLED is not true"), fields, deps);
    return;
  }

  try {
    const result = await handler(payload, config, body, logger);
    logOutcome(logger, {
      fields: { ...fields, ...result.fields, totalMs: Date.now() - startedAtMs },
      outcome: result.outcome,
      ack: true,
    });
    res.status(STATUS.ack).send();
  } catch (err) {
    respondToFailure(res, err, { ...fields, totalMs: Date.now() - startedAtMs }, deps);
  }
}

/** The only place the ACK/NACK decision is made. */
function respondToFailure(res: Response, err: unknown, fields: Record<string, unknown>, deps: PushHandlerDeps): void {
  const ack = !isRetriable(err);
  logOutcome(deps.logger, {
    fields,
    outcome: ack ? "failed_terminal" : "failed_retriable",
    ack,
    error: err,
  });
  res.status(ack ? STATUS.ack : STATUS.nack).send();
}

/**
 * On every outcome: with no dead-letter policy Pub/Sub omits `deliveryAttempt`, leaving `messageId` as
 * the only way to correlate a redelivery with its earlier attempts.
 */
function deliveryFields(config: DepositAddressServiceConfig, body: PubSubPushMessage): Record<string, unknown> {
  return {
    executionEnabled: config.executionEnabled,
    messageId: body.message?.messageId,
    publishTime: body.message?.publishTime,
    orderingKey: body.message?.orderingKey,
    subscription: body.subscription,
    deliveryAttempt: body.deliveryAttempt,
  };
}

/**
 * The one log line for this message. Level follows the error's `alert` flag, so severity is a property
 * of the condition rather than a per-call-site judgement: `alert` ⇒ `error`, which pages, else `debug`.
 *
 * The failure block is `failure`, not `error` — a reserved key that `@risk-labs/logger`'s
 * errorStackTracerFormatter collapses to `error.stack || error.message`, losing the structure.
 */
function logOutcome(
  logger: winston.Logger,
  args: { fields: Record<string, unknown>; outcome: string; ack: boolean; error?: unknown }
): void {
  const { fields, outcome, ack, error } = args;
  const alert = isDefined(error) && shouldAlert(error);

  const line = {
    at: AT,
    message: `deposit-address message ${ack ? "acknowledged" : "returned for redelivery"}: ${outcome}`,
    ...fields,
    outcome,
    ack,
    ...(isDefined(error)
      ? {
          failure: {
            type: error instanceof Error ? error.name : typeof error,
            code: errorCode(error),
            message: error instanceof Error ? error.message : String(error),
            retriable: isRetriable(error),
            detail: stringifyThrownValue(error),
          },
        }
      : {}),
    ...(alert ? { notificationPath: ALERT_NOTIFICATION_PATH } : {}),
  };

  if (alert) {
    logger.error(line);
  } else {
    logger.debug(line);
  }
}
