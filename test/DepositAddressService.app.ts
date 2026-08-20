import { AddressInfo } from "net";
import { Server } from "http";
import { expect, sinon, winston } from "./utils";
import { createApp } from "../src/deposit-address-service/app";
import { DepositAddressServiceConfig } from "../src/deposit-address-service/config";
import { RequestLifecycle } from "../src/deposit-address-service/lifecycle";
import { MessageHandler } from "../src/deposit-address-service/handler";
import { ExecutionDisabledError, MessageValidationError } from "../src/deposit-address-service/errors";

/**
 * Exercises the real Express boundary over real HTTP, rather than calling the route function with
 * fake req/res objects. `supertest` is not a dependency and is not needed: binding to port 0 and
 * using the global `fetch` tests the same surface, including body parsing and status codes.
 */
describe("DepositAddressService app", function () {
  const PAYLOAD = JSON.stringify({ version: 3, hello: "world" });

  let server: Server;
  let baseUrl: string;
  let lifecycle: RequestLifecycle;
  let logs: { level: string; payload: Record<string, unknown> }[];
  let handlerStub: sinon.SinonStub;

  function recordingLogger(): winston.Logger {
    const record = (level: string) => (payload: Record<string, unknown>) => void logs.push({ level, payload });
    return {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    } as unknown as winston.Logger;
  }

  function lastLine(): Record<string, unknown> {
    expect(logs.length).to.be.greaterThan(0);
    return logs[logs.length - 1].payload;
  }

  function pushBody(payload: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      message: {
        data: Buffer.from(payload, "utf8").toString("base64"),
        messageId: "msg-9931",
        publishTime: "2026-08-05T10:00:00.000Z",
      },
      subscription: "projects/p/subscriptions/s",
      ...overrides,
    });
  }

  async function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
  }

  async function start(env: Record<string, string> = {}, overrides: { handler?: MessageHandler } = {}): Promise<void> {
    const config = new DepositAddressServiceConfig({ EXECUTION_ENABLED: "true", ...env });
    const app = createApp({
      logger: recordingLogger(),
      config,
      lifecycle,
      handler: overrides.handler ?? (handlerStub as unknown as MessageHandler),
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  beforeEach(function () {
    logs = [];
    lifecycle = new RequestLifecycle();
    handlerStub = sinon.stub().resolves({ outcome: "deposit_executed" });
  });

  afterEach(async function () {
    sinon.restore();
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("ACKs with 204 and logs exactly one line on success", async function () {
    await start();
    const response = await post(pushBody(PAYLOAD));

    expect(response.status).to.equal(204);
    expect(handlerStub.calledOnce).to.equal(true);
    expect(handlerStub.firstCall.args[0].delivery.payload).to.equal(PAYLOAD);

    // Exactly one log line for the whole request.
    expect(logs.length).to.equal(1);
    const line = lastLine();
    expect(line.outcome).to.equal("deposit_executed");
    expect(line.ack).to.equal(true);
    expect(line.totalMs).to.be.a("number");
    // Delivery identity on every outcome: without a DLQ there is no deliveryAttempt, so messageId is
    // the only way to correlate a redelivery with earlier attempts.
    expect(line.messageId).to.equal("msg-9931");
    expect(line.subscription).to.equal("projects/p/subscriptions/s");
  });

  it("hands the handler one request context, with no process-scoped dependencies", async function () {
    await start({ APPLICATION_DEADLINE_MS: "480000" });
    const before = Date.now();
    await post(pushBody(PAYLOAD));

    // Exactly one argument: config, logger and the shared clients are closed over at construction, so a
    // handler cannot build a per-request TransactionClient and split the nonce cache.
    expect(handlerStub.firstCall.args.length).to.equal(1);
    const ctx = handlerStub.firstCall.args[0];

    expect(ctx.delivery.payload).to.equal(PAYLOAD);
    expect(ctx.delivery.messageId).to.equal("msg-9931");
    expect(ctx.delivery.publishTime).to.equal("2026-08-05T10:00:00.000Z");
    expect(ctx.delivery.subscription).to.equal("projects/p/subscriptions/s");
    expect(ctx.delivery.attributes).to.deep.equal({});

    // Absolute, created once at the boundary, so every layer reads the same instant.
    expect(ctx.deadlineAtMs).to.equal(ctx.startedAtMs + 480_000);
    expect(ctx.startedAtMs).to.be.at.least(before);
    expect(ctx.signal.aborted).to.equal(false);
  });

  it("does not overwrite delivery identity with handler fields", async function () {
    // Transport metadata is ground truth: a handler must not be able to relabel which message this was.
    handlerStub.resolves({ outcome: "deposit_executed", fields: { messageId: "spoofed", ack: false } });
    await start();

    await post(pushBody(PAYLOAD));

    const line = lastLine();
    expect(line.messageId).to.equal("msg-9931");
    expect(line.ack).to.equal(true);
  });

  it("does not let handler fields overwrite the canonical log keys", async function () {
    handlerStub.resolves({
      outcome: "deposit_executed",
      fields: { at: "spoofed", message: "spoofed", outcome: "spoofed" },
    });
    await start();

    await post(pushBody(PAYLOAD));

    const line = lastLine();
    expect(line.at).to.equal("DepositAddressService#push");
    expect(line.outcome).to.equal("deposit_executed");
    expect(line.message).to.contain("acknowledged");
  });

  it("NACKs with 500 when the handler throws a retriable error", async function () {
    handlerStub.rejects(new ExecutionDisabledError("execution is disabled"));
    await start();

    const response = await post(pushBody(PAYLOAD));

    expect(response.status).to.equal(500);
    const line = lastLine();
    expect(line.ack).to.equal(false);
    expect((line.failure as Record<string, unknown>).code).to.equal("EXECUTION_DISABLED");
    expect((line.failure as Record<string, unknown>).retriable).to.equal(true);
    // Level follows the error's `alert` flag, not whether it is retriable: this one does not alert.
    expect(logs[logs.length - 1].level).to.equal("debug");
  });

  it("ACKs with 204 when the handler throws a terminal error", async function () {
    handlerStub.rejects(new MessageValidationError("schema mismatch"));
    await start();

    const response = await post(pushBody(PAYLOAD));

    // Terminal means redelivery cannot help; without a DLQ, a non-2xx would retry it forever.
    expect(response.status).to.equal(204);
    const line = lastLine();
    expect(line.ack).to.equal(true);
    expect((line.failure as Record<string, unknown>).retriable).to.equal(false);
    // No typed error alerts today, so this stays out of the paging path.
    expect(line).to.not.have.property("notificationPath");
    expect(logs[logs.length - 1].level).to.equal("debug");
  });

  it("logs non-alerting outcomes at debug", async function () {
    await start();
    await post(pushBody(PAYLOAD));

    expect(logs[logs.length - 1].level).to.equal("debug");
  });

  async function startWithoutHandler(env: Record<string, string> = {}): Promise<void> {
    const config = new DepositAddressServiceConfig({ ...env });
    const app = createApp({ logger: recordingLogger(), config, lifecycle });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  it("NACKs rather than discarding when no handler is configured", async function () {
    // A shell that ACKed would silently throw away real transfers if a subscription were attached.
    await startWithoutHandler({ EXECUTION_ENABLED: "true" });

    const response = await post(pushBody(PAYLOAD));

    expect(response.status).to.equal(500);
    const line = lastLine();
    expect(line.ack).to.equal(false);
    expect((line.failure as Record<string, unknown>).code).to.equal("EXECUTION_DISABLED");
  });

  it("NACKs when EXECUTION_ENABLED is not true, whatever handler is injected", async function () {
    // Enforced in the app, not just the default handler, so the switch cannot be bypassed.
    await start({ EXECUTION_ENABLED: "false" });

    const response = await post(pushBody(PAYLOAD));

    expect(response.status).to.equal(500);
    expect(handlerStub.notCalled).to.equal(true);
    expect((lastLine().failure as Record<string, unknown>).code).to.equal("EXECUTION_DISABLED");
  });

  it("reports readiness false until execution is enabled and a handler is configured", async function () {
    await startWithoutHandler({ EXECUTION_ENABLED: "true" });

    const response = await fetch(`${baseUrl}ready`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).to.equal(503);
    expect(body.ready).to.equal(false);
    expect(body.handlerConfigured).to.equal(false);
    expect(body.executionEnabled).to.equal(true);
  });

  it("survives a non-string `data` instead of crashing the process", async function () {
    // Buffer.from(number) throws, and Express 4 does not handle rejected async route promises — so
    // without the type check plus the route error boundary this became an unhandled rejection.
    await start();

    const response = await post(JSON.stringify({ message: { data: 12345, messageId: "m-numeric" } }));

    expect(response.status).to.equal(204);
    expect(lastLine().outcome).to.equal("dropped_undecodable_message");
  });

  it("does not decode an array `data` into a junk payload", async function () {
    // Buffer.from([...]) does not throw; it reads the array as raw bytes and yields nonsense.
    await start();

    const response = await post(JSON.stringify({ message: { data: [104, 105], messageId: "m-array" } }));

    expect(response.status).to.equal(204);
    expect(handlerStub.notCalled).to.equal(true);
    expect(lastLine().outcome).to.equal("dropped_undecodable_message");
  });

  it("ACKs unparseable JSON with a log line instead of Express's bare 400", async function () {
    // A non-2xx here would redeliver forever, since there is no dead-letter policy to eject it.
    await start();

    const response = await post("{not json");

    expect(response.status).to.equal(204);
    const line = lastLine();
    expect(line.outcome).to.equal("dropped_malformed_request_body");
    expect((line.failure as Record<string, unknown>).code).to.equal("MALFORMED_REQUEST_BODY");
  });

  it("ACKs a body over the 1mb limit", async function () {
    // The limit is a fixed constant, not configurable: express.json runs it through bytes.parse, which
    // fails silently — a typo would either remove the cap or shrink it to a few bytes.
    await start();

    const response = await post(pushBody("x".repeat(1_100_000)));

    expect(response.status).to.equal(204);
    expect(handlerStub.notCalled).to.equal(true);
    expect(lastLine().outcome).to.equal("dropped_malformed_request_body");
  });

  it("NACKs and stays alive when the handler throws a non-Error value", async function () {
    handlerStub.rejects("a string rejection");
    await start();

    const response = await post(pushBody(PAYLOAD));

    expect(response.status).to.equal(500);
    expect(lastLine().outcome).to.equal("failed_retriable");
  });

  it("still NACKs when the thrown value cannot be serialized", async function () {
    // stringifyThrownValue throws on a circular non-Error. Unguarded, that throw happens on the catch
    // path, so the 500 is never sent, Express sees an unhandled rejection, and the process exits —
    // abandoning every other in-flight delivery.
    const circular: Record<string, unknown> = { name: "req" };
    circular.self = circular;
    handlerStub.callsFake(async () => {
      throw circular;
    });
    await start();

    const response = await post(pushBody(PAYLOAD));

    expect(response.status).to.equal(500);
    const failure = lastLine().failure as Record<string, unknown>;
    expect(failure.retriable).to.equal(true);
    // The guarded serializer degrades only `detail`, so the type and code survive.
    expect(failure.type).to.equal("object");
    expect(failure.code).to.equal("UNEXPECTED_ERROR");
    expect(failure.detail).to.equal("<unserializable object>");
  });

  it("still NACKs when the thrown value's toString throws", async function () {
    // The remaining path to describeFailure's own fallback: safeStringifyThrownValue covers the
    // serializer, but `String(error)` for the message can still throw on a hostile value.
    handlerStub.callsFake(async () => {
      throw {
        toString() {
          throw new Error("nope");
        },
      };
    });
    await start();

    const response = await post(pushBody(PAYLOAD));

    expect(response.status).to.equal(500);
    const failure = lastLine().failure as Record<string, unknown>;
    expect(failure.type).to.equal("unserializable");
    expect(failure.retriable).to.equal(true);
  });

  it("puts the failure under `failure`, never under the reserved `error` key", async function () {
    // `@risk-labs/logger`'s errorStackTracerFormatter rewrites info.error to
    // `error.stack || error.message || ...`, which silently collapses a structured object to a string.
    handlerStub.rejects(new MessageValidationError("schema mismatch"));
    await start();

    await post(pushBody(PAYLOAD));

    const line = lastLine();
    expect(line).to.not.have.property("error");
    const failure = line.failure as Record<string, unknown>;
    expect(failure.code).to.equal("MESSAGE_VALIDATION_FAILED");
    expect(failure.type).to.equal("MessageValidationError");
    expect(failure.message).to.equal("schema mismatch");
    expect(failure.detail).to.be.a("string");
  });

  it("merges handler-supplied fields onto the line", async function () {
    handlerStub.resolves({ outcome: "deposit_executed", fields: { originChainId: 42161, txHash: "0xabc" } });
    await start();

    await post(pushBody(PAYLOAD));

    const line = lastLine();
    expect(line.originChainId).to.equal(42161);
    expect(line.txHash).to.equal("0xabc");
    expect(line.totalMs).to.be.a("number");
  });

  it("treats an unrecognised thrown value as retriable and alerts on it", async function () {
    handlerStub.rejects(new Error("something unexpected"));
    await start();

    const response = await post(pushBody(PAYLOAD));

    expect(response.status).to.equal(500);
    const line = lastLine();
    expect((line.failure as Record<string, unknown>).code).to.equal("UNEXPECTED_ERROR");
    // The only remaining path to `error`: a condition we never modelled. Giving it a typed error is
    // how the alert gets turned off.
    expect(line.notificationPath).to.equal("across-bot-error");
    expect(logs[logs.length - 1].level).to.equal("error");
  });

  it("ACKs an undecodable Pub/Sub message rather than retrying it forever", async function () {
    await start();
    const response = await post(JSON.stringify({ message: { messageId: "msg-bad" }, subscription: "s" }));

    expect(response.status).to.equal(204);
    expect(handlerStub.notCalled).to.equal(true);
    const line = lastLine();
    expect(line.outcome).to.equal("dropped_undecodable_message");
    expect(line.messageId).to.equal("msg-bad");
    // Deliberately not an alert: as likely a probe as a producer bug.
    expect(line).to.not.have.property("notificationPath");
    expect(logs[logs.length - 1].level).to.equal("debug");
  });

  it("400s a request that is not a Pub/Sub push delivery", async function () {
    await start();
    const response = await post(JSON.stringify({ notAPushRequest: true }));

    expect(response.status).to.equal(400);
    expect(handlerStub.notCalled).to.equal(true);
    expect(lastLine().outcome).to.equal("rejected_not_a_push_request");
  });

  it("503s new pushes while draining, so Pub/Sub redelivers to a live instance", async function () {
    await start();
    void lifecycle.beginDraining(1_000);

    const response = await post(pushBody(PAYLOAD));

    expect(response.status).to.equal(503);
    expect(handlerStub.notCalled).to.equal(true);
  });

  it("reports readiness false while draining but stays live", async function () {
    await start({ EXECUTION_ENABLED: "true" });
    expect((await fetch(`${baseUrl}ready`)).status).to.equal(200);

    void lifecycle.beginDraining(1_000);

    expect((await fetch(`${baseUrl}ready`)).status).to.equal(503);
    // Liveness is deliberately independent, so a draining instance is not restarted mid-request.
    expect((await fetch(`${baseUrl}health`)).status).to.equal(200);
  });

  it("counts a request as in flight for the duration of the handler", async function () {
    let observedInFlight = -1;
    await start(
      {},
      {
        handler: async () => {
          observedInFlight = lifecycle.inFlightCount;
          return { outcome: "deposit_executed" };
        },
      }
    );

    await post(pushBody(PAYLOAD));

    expect(observedInFlight).to.equal(1);
    expect(lifecycle.inFlightCount).to.equal(0);
  });
});
