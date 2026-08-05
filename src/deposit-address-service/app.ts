import express, { Express, NextFunction, Request, Response } from "express";
import winston from "winston";
import { DepositAddressServiceConfig } from "./config";
import { MessageHandler, RequestContext, unconfiguredHandler } from "./handler";
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
import { PubSubPushMessage, PushDelivery, decodePushDelivery, isPushRequest } from "../messaging/gcp";
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
 * `"100mbb"` yields 100 bytes and rejects everything.
 */
const JSON_BODY_LIMIT = "1mb";

/**
 * `type` values body-parser sets on the errors it rejects with. Anything reaching the error middleware
 * *without* one of these came from somewhere else and must not be quietly acknowledged.
 */
const BODY_PARSER_ERROR_TYPES = new Set([
  "encoding.unsupported",
  "entity.parse.failed",
  "entity.too.large",
  "entity.verify.failed",
  "charset.unsupported",
  "parameters.too.many",
  "request.aborted",
  "request.size.invalid",
]);

export function isBodyParserError(err: unknown): boolean {
  const type = (err as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" && BODY_PARSER_ERROR_TYPES.has(type);
}

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
  /**
   * Constructed once by the caller with its dependencies closed over, so a Cloud Run instance builds one
   * `TransactionClient` rather than one per request. Absent ⇒ the service refuses every delivery.
   */
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
      respondToFailure(res, err, bestEffortFields(config, req.body), pushDeps);
    } finally {
      complete();
    }
  });

  // Last, so it catches body-parser failures, which reject before any route runs. Express would
  // otherwise answer its own non-2xx with no log line — and a non-2xx redelivers forever without a DLQ.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const fields = { executionEnabled: config.executionEnabled, bodyParserType: (err as { type?: string }).type };
    if (isBodyParserError(err)) {
      logOutcome(logger, {
        fields,
        outcome: "dropped_malformed_request_body",
        ack: true,
        error: new MalformedRequestBodyError(err.message),
      });
      res.status(STATUS.ack).send();
      return;
    }

    // Not body-parser: some other middleware failed, and that may well be transient. Preserve the
    // message rather than acknowledging away work on a guess. `respondToFailure` alerts on it, since an
    // unrecognised error is the one condition where silence is worse than noise.
    respondToFailure(res, err, fields, pushDeps);
  });

  return app;
}

interface PushHandlerDeps {
  logger: winston.Logger;
  config: DepositAddressServiceConfig;
  handler: MessageHandler;
}

async function handlePush(req: Request, res: Response, deps: PushHandlerDeps): Promise<void> {
  const { logger, config } = deps;

  // Not a Pub/Sub envelope at all. A 4xx is safe here and only here: there is no subscription behind it,
  // so it cannot become a redelivery loop.
  if (!isPushRequest(req.body)) {
    logOutcome(logger, {
      fields: bestEffortFields(config, req.body),
      outcome: "rejected_not_a_push_request",
      ack: false,
      error: new NotAPushRequestError("Request body has no Pub/Sub `message` object"),
    });
    res.status(STATUS.badRequest).send("Bad Request: not a Pub/Sub push delivery");
    return;
  }

  // A real delivery that fails the transport contract. ACK: with no dead-letter policy a non-2xx would
  // redeliver it forever, and redelivery cannot supply a payload or an id that was never sent.
  const delivery = decodePushDelivery(req.body);
  if (!isDefined(delivery)) {
    logOutcome(logger, {
      fields: bestEffortFields(config, req.body),
      outcome: "dropped_undecodable_message",
      ack: true,
      error: new UndecodablePushMessageError("Pub/Sub message has no decodable `data` or no `messageId`"),
    });
    res.status(STATUS.ack).send();
    return;
  }

  await runHandler(res, delivery, deps);
}

async function runHandler(res: Response, delivery: PushDelivery, deps: PushHandlerDeps): Promise<void> {
  const { logger, config, handler } = deps;
  const startedAtMs = Date.now();
  const fields = deliveryFields(config, delivery);

  // Enforced here, not only in the default handler, so the switch holds for any injected handler.
  // Retriable, so a service disabled by mistake preserves its work rather than discarding it.
  if (!config.executionEnabled) {
    respondToFailure(res, new ExecutionDisabledError("EXECUTION_ENABLED is not true"), fields, deps);
    return;
  }

  const context: RequestContext = {
    delivery,
    startedAtMs,
    deadlineAtMs: startedAtMs + config.applicationDeadlineMs,
    signal: AbortSignal.timeout(config.applicationDeadlineMs),
  };

  try {
    const result = await handler(context);
    logOutcome(logger, {
      // Handler fields first: delivery identity is transport ground truth and must win a collision.
      fields: { ...result.fields, ...fields, totalMs: Date.now() - startedAtMs },
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

/** Identity from a delivery that passed the transport contract, so nothing needs optional chaining. */
function deliveryFields(config: DepositAddressServiceConfig, delivery: PushDelivery): Record<string, unknown> {
  return {
    executionEnabled: config.executionEnabled,
    messageId: delivery.messageId,
    publishTime: delivery.publishTime,
    orderingKey: delivery.orderingKey,
    subscription: delivery.subscription,
    // Absent unless the subscription has a dead-letter policy, which this service does not use.
    deliveryAttempt: delivery.deliveryAttempt,
  };
}

/**
 * Whatever identity can be salvaged from a body that failed the transport contract — the only context
 * those paths have for naming what was dropped. Deliberately defensive: nothing here is guaranteed.
 */
function bestEffortFields(config: DepositAddressServiceConfig, body: unknown): Record<string, unknown> {
  const raw = (body ?? {}) as PubSubPushMessage;
  const message = (raw.message ?? {}) as Record<string, unknown>;
  const asString = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    executionEnabled: config.executionEnabled,
    messageId: asString(message.messageId),
    subscription: asString(raw.subscription),
  };
}

/**
 * Never throws — this runs on the catch path, so a throw here would mean the intended 500 is never
 * sent, Express sees an unhandled rejection, and the fatal handler exits the process, abandoning every
 * other in-flight delivery. `stringifyThrownValue` guards its `Error` branch but not its non-`Error`
 * one, where a value with circular references throws.
 *
 * `code` and `retriable` are read before the try so the fallback itself cannot fail.
 */
function describeFailure(error: unknown): Record<string, unknown> {
  const code = errorCode(error);
  const retriable = isRetriable(error);
  try {
    return {
      type: error instanceof Error ? error.name : typeof error,
      code,
      message: error instanceof Error ? error.message : String(error),
      retriable,
      detail: stringifyThrownValue(error),
    };
  } catch {
    return { type: "unserializable", code, message: "failed to serialize thrown value", retriable };
  }
}

/**
 * The one log line for this message. Level follows the error's `alert` flag, so severity is a property
 * of the condition rather than a per-call-site judgement: `alert` ⇒ `error`, which pages, else `debug`.
 *
 * Caller-supplied fields are spread **first** so they cannot overwrite `at`, `message`, `outcome`, `ack`
 * or `failure` — a handler must not be able to disguise the outcome of its own request.
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
    ...fields,
    at: AT,
    message: `deposit-address message ${ack ? "acknowledged" : "returned for redelivery"}: ${outcome}`,
    outcome,
    ack,
    ...(isDefined(error) ? { failure: describeFailure(error) } : {}),
    ...(alert ? { notificationPath: ALERT_NOTIFICATION_PATH } : {}),
  };

  if (alert) {
    logger.error(line);
  } else {
    logger.debug(line);
  }
}
