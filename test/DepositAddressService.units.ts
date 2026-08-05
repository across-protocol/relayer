import { expect } from "./utils";
import { decodePubSubData } from "../src/messaging/gcp";
import { RequestLifecycle } from "../src/deposit-address-service/lifecycle";
import { DepositAddressServiceConfig } from "../src/deposit-address-service/config";
import { errorCode, isRetriable, shouldAlert } from "../src/deposit-address-service/errors";

describe("decodePubSubData", function () {
  function encode(payload: string): string {
    return Buffer.from(payload, "utf8").toString("base64");
  }

  it("decodes and trims a base64 payload", function () {
    // Trimmed, matching how the cctp-finalizer treats push payloads.
    expect(decodePubSubData(encode(' {"a":1} '))).to.equal('{"a":1}');
  });

  it("returns undefined when there is nothing usable to decode", function () {
    for (const data of [undefined, "", encode(""), encode("   ")]) {
      expect(decodePubSubData(data), String(data)).to.equal(undefined);
    }
  });

  it("rejects non-string data rather than throwing or decoding junk", function () {
    // Buffer.from(number) throws; Buffer.from(array) silently reads the array as bytes. Neither may
    // reach the caller, since a throw here escapes the ACK/NACK policy.
    for (const data of [12345, { a: 1 }, [104, 105], null, true]) {
      expect(decodePubSubData(data), JSON.stringify(data)).to.equal(undefined);
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

describe("DepositAddressServiceConfig", function () {
  it("defaults execution off, so a build cannot act before its paths are reviewed", function () {
    expect(new DepositAddressServiceConfig({}).executionEnabled).to.equal(false);
    expect(new DepositAddressServiceConfig({ EXECUTION_ENABLED: "TRUE" }).executionEnabled).to.equal(false);
    expect(new DepositAddressServiceConfig({ EXECUTION_ENABLED: "true" }).executionEnabled).to.equal(true);
  });

  it("keeps the application deadline inside the Cloud Run request timeout", function () {
    // 480s application deadline < 540s Cloud Run timeout < 600s lock TTL. The application deadline is
    // the enforceable one, because a Cloud Run 504 does not stop handler code.
    expect(new DepositAddressServiceConfig({}).applicationDeadlineMs).to.equal(480_000);
  });

  it("falls back to defaults on unparseable numeric env", function () {
    const config = new DepositAddressServiceConfig({ PORT: "not-a-port", APPLICATION_DEADLINE_MS: "-5" });
    expect(config.port).to.equal(8080);
    expect(config.applicationDeadlineMs).to.equal(480_000);
  });

  it("rejects an application deadline at or past the Cloud Run request timeout", function () {
    // Past 540s Cloud Run gives up first, so the deadline would guarantee nothing.
    for (const value of ["540000", "600000"]) {
      expect(() => new DepositAddressServiceConfig({ APPLICATION_DEADLINE_MS: value }), value).to.throw(
        /must be below the Cloud Run request timeout/
      );
    }
    expect(new DepositAddressServiceConfig({ APPLICATION_DEADLINE_MS: "539000" }).applicationDeadlineMs).to.equal(
      539_000
    );
  });

  it("keeps the drain timeout inside Cloud Run's SIGKILL grace period", function () {
    // Cloud Run SIGKILLs 10s after SIGTERM, so a longer drain is killed before it can finish.
    expect(new DepositAddressServiceConfig({}).shutdownDrainTimeoutMs).to.equal(8_000);
    expect(() => new DepositAddressServiceConfig({ SHUTDOWN_DRAIN_TIMEOUT_MS: "25000" })).to.throw(
      /exceeds Cloud Run's SIGKILL grace period/
    );
  });
});

describe("error taxonomy", function () {
  it("defaults unrecognised errors to retriable and alerting", function () {
    expect(isRetriable(new Error("boom"))).to.equal(true);
    expect(shouldAlert(new Error("boom"))).to.equal(true);
    expect(errorCode(new Error("boom"))).to.equal("UNEXPECTED_ERROR");
  });
});
