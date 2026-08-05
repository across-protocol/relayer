import { expect } from "./utils";
import { decodePushDelivery, isPushRequest } from "../src/messaging/gcp";
import { isBodyParserError } from "../src/deposit-address-service/app";
import { RequestLifecycle } from "../src/deposit-address-service/lifecycle";
import { errorCode, isRetriable, safeStringifyThrownValue, shouldAlert } from "../src/deposit-address-service/errors";

describe("isPushRequest", function () {
  it("distinguishes a Pub/Sub envelope from anything else", function () {
    expect(isPushRequest({ message: {} })).to.equal(true);
    for (const body of [undefined, null, "str", 7, [], {}, { subscription: "s" }, { message: "no" }]) {
      expect(isPushRequest(body), JSON.stringify(body)).to.equal(false);
    }
  });
});

describe("decodePushDelivery", function () {
  const encode = (payload: string) => Buffer.from(payload, "utf8").toString("base64");
  const valid = (over: Record<string, unknown> = {}) => ({
    message: { data: encode(' {"a":1} '), messageId: "m1", ...over },
    subscription: "projects/p/subscriptions/s",
    deliveryAttempt: 3,
  });

  it("returns a trusted delivery, trimming the payload", function () {
    const d = decodePushDelivery(valid({ publishTime: "t", orderingKey: "k", attributes: { x: "1" } }));
    expect(d).to.not.equal(undefined);
    // Trimmed, matching how the cctp-finalizer treats push payloads.
    expect(d?.payload).to.equal('{"a":1}');
    expect(d?.messageId).to.equal("m1");
    expect(d?.publishTime).to.equal("t");
    expect(d?.orderingKey).to.equal("k");
    expect(d?.subscription).to.equal("projects/p/subscriptions/s");
    expect(d?.deliveryAttempt).to.equal(3);
    expect(d?.attributes).to.deep.equal({ x: "1" });
  });

  it("always supplies attributes, so callers never optional-chain them", function () {
    expect(decodePushDelivery(valid())?.attributes).to.deep.equal({});
  });

  it("rejects a delivery with no usable payload", function () {
    for (const data of [undefined, "", encode(""), encode("   ")]) {
      expect(decodePushDelivery(valid({ data })), String(data)).to.equal(undefined);
    }
  });

  it("rejects non-string data rather than throwing or decoding junk", function () {
    // Buffer.from(number) throws; Buffer.from(array) silently reads the array as bytes. A throw here
    // would escape the caller's ACK/NACK policy.
    for (const data of [12345, { a: 1 }, [104, 105], null, true]) {
      expect(decodePushDelivery(valid({ data })), JSON.stringify(data)).to.equal(undefined);
    }
  });

  it("requires messageId, the only redelivery-correlation key without deliveryAttempt", function () {
    for (const messageId of [undefined, "", 42]) {
      expect(decodePushDelivery(valid({ messageId })), String(messageId)).to.equal(undefined);
    }
  });

  it("drops wrongly-typed optional metadata instead of rejecting the delivery", function () {
    // Discarding a diagnostic field beats discarding funds work over one.
    const d = decodePushDelivery(valid({ publishTime: 99, orderingKey: {}, attributes: { ok: "y", bad: 1 } }));
    expect(d?.payload).to.equal('{"a":1}');
    expect(d?.publishTime).to.equal(undefined);
    expect(d?.orderingKey).to.equal(undefined);
    expect(d?.attributes).to.deep.equal({ ok: "y" });
  });
});

describe("isBodyParserError", function () {
  it("recognises the errors body-parser rejects with", function () {
    for (const type of ["entity.parse.failed", "entity.too.large", "encoding.unsupported", "request.aborted"]) {
      expect(isBodyParserError(Object.assign(new Error("x"), { type })), type).to.equal(true);
    }
  });

  it("does not claim errors from anywhere else", function () {
    // Those may be transient, so they must NACK rather than be acknowledged away — a blanket ACK on
    // every middleware error would silently discard the message.
    for (const err of [
      new Error("boom"),
      Object.assign(new Error("x"), { type: "something.else" }),
      null,
      undefined,
      "str",
    ]) {
      expect(isBodyParserError(err), String(err)).to.equal(false);
    }
  });
});

describe("RequestLifecycle", function () {
  it("tracks in-flight requests and ignores a double release", function () {
    const lifecycle = new RequestLifecycle();
    expect(lifecycle.inFlightCount).to.equal(0);

    const done = lifecycle.begin();
    expect(lifecycle.inFlightCount).to.equal(1);

    done();
    done();
    expect(lifecycle.inFlightCount).to.equal(0);
  });

  it("stops accepting requests once draining", async function () {
    const lifecycle = new RequestLifecycle();
    expect(lifecycle.acceptingRequests).to.equal(true);

    await lifecycle.beginDraining(50);
    expect(lifecycle.acceptingRequests).to.equal(false);
  });

  it("resolves the drain as soon as the last request completes", async function () {
    const lifecycle = new RequestLifecycle();
    const done = lifecycle.begin();

    const draining = lifecycle.beginDraining(5_000);
    done();

    expect(await draining).to.equal(true);
  });

  it("reports a timed-out drain rather than hanging", async function () {
    const lifecycle = new RequestLifecycle();
    lifecycle.begin();

    expect(await lifecycle.beginDraining(20)).to.equal(false);
  });
});

describe("safeStringifyThrownValue", function () {
  it("serializes normally when it can", function () {
    expect(safeStringifyThrownValue(new Error("boom"))).to.contain("boom");
    expect(safeStringifyThrownValue("plain string")).to.contain("plain string");
  });

  it("falls back instead of throwing on a circular non-Error", function () {
    // Unguarded this throws. On the route path that means the intended 500 is never sent; in the fatal
    // handlers it means the page describes the serializer and the real cause is lost.
    const circular: Record<string, unknown> = { name: "req" };
    circular.self = circular;

    expect(() => safeStringifyThrownValue(circular)).to.not.throw();
    expect(safeStringifyThrownValue(circular)).to.equal("<unserializable object>");
  });

  it("survives a value whose toString throws", function () {
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(() => safeStringifyThrownValue(hostile)).to.not.throw();
  });
});

describe("error taxonomy", function () {
  it("defaults unrecognised errors to retriable and alerting", function () {
    expect(isRetriable(new Error("boom"))).to.equal(true);
    expect(shouldAlert(new Error("boom"))).to.equal(true);
    expect(errorCode(new Error("boom"))).to.equal("UNEXPECTED_ERROR");
  });
});
