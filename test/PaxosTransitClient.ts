import sinon from "sinon";
import { expect } from "chai";
import {
  PaxosTransitApiError,
  PaxosTransitClient,
  getPaxosTransitMinimumOfferAmount,
  isPaxosTransitAmountBelowMinimumError,
  toBN,
} from "../src/utils";

// Verbatim rejection from `GET v1/transit/orders/quote` for a mainnet USDG -> Robinhood sweep of
// 137.911345 USDG on 2026-08-15, when Paxos's floating order minimum sat at $160.93.
const BELOW_MINIMUM_BODY = JSON.stringify({
  error: {
    code: 400,
    message: "Order amount is below the minimum of $160.93 (160924200 base units). Please increase your offer amount.",
    status: "INVALID_ARGUMENT",
  },
});

describe("PaxosTransitClient", function () {
  let client: PaxosTransitClient;

  beforeEach(function () {
    // One retry keeps the retry assertions cheap; getWithRetry sleeps 1s between attempts.
    client = new PaxosTransitClient("https://mock-paxos.test", "test-api-key", undefined, 1);
  });

  afterEach(() => sinon.restore());

  it("returns the parsed body and sends the api key", async function () {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    expect(await client.getWithRetry("v1/transit/orders")).to.deep.equal({ ok: true });
    expect(fetchStub.firstCall.args[0]).to.equal("https://mock-paxos.test/v1/transit/orders");
    expect((fetchStub.firstCall.args[1]?.headers as Record<string, string>)["x-api-key"]).to.equal("test-api-key");
  });

  it("throws a PaxosTransitApiError carrying the API's message and status", async function () {
    sinon
      .stub(globalThis, "fetch")
      .resolves(new Response(BELOW_MINIMUM_BODY, { status: 400, statusText: "Bad Request" }));

    const err = await client.getWithRetry("v1/transit/orders/quote").then(
      () => undefined,
      (e) => e
    );
    expect(err).to.be.instanceOf(PaxosTransitApiError);
    expect(err.status).to.equal(400);
    expect(err.apiStatus).to.equal("INVALID_ARGUMENT");
    // Without the structured body this reaches the logs as `HttpError: [object Object]`.
    expect(err.message).to.include("Order amount is below the minimum of $160.93");
  });

  it("falls back to the status line when the error body is not JSON", async function () {
    // A fresh Response per call: 502 is retryable, and a Response body can only be read once.
    sinon
      .stub(globalThis, "fetch")
      .callsFake(async () => new Response("<html>gateway</html>", { status: 502, statusText: "Bad Gateway" }));

    const err = await client.getWithRetry("v1/transit/orders").then(
      () => undefined,
      (e) => e
    );
    expect(err).to.be.instanceOf(PaxosTransitApiError);
    expect(err.status).to.equal(502);
    expect(err.apiStatus).to.equal(undefined);
    expect(err.message).to.equal("HTTP 502: Bad Gateway");
  });

  it("does not retry a rejected request", async function () {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(new Response(BELOW_MINIMUM_BODY, { status: 400, statusText: "Bad Request" }));

    await client.getWithRetry("v1/transit/orders/quote").catch(() => undefined);
    expect(fetchStub.callCount).to.equal(1);
  });

  it("retries a transient failure", async function () {
    const fetchStub = sinon.stub(globalThis, "fetch");
    fetchStub.onFirstCall().resolves(new Response("", { status: 503, statusText: "Service Unavailable" }));
    fetchStub.onSecondCall().resolves(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    expect(await client.getWithRetry("v1/transit/orders")).to.deep.equal({ ok: true });
    expect(fetchStub.callCount).to.equal(2);
  });

  describe("below-minimum classification", function () {
    it("recognises a below-minimum rejection and reads back the live minimum", function () {
      const error = new PaxosTransitApiError(
        400,
        "Order amount is below the minimum of $160.93 (160924200 base units). Please increase your offer amount.",
        "INVALID_ARGUMENT"
      );
      expect(isPaxosTransitAmountBelowMinimumError(error)).to.equal(true);
      expect(getPaxosTransitMinimumOfferAmount(error)?.eq(toBN(160924200))).to.equal(true);
    });

    it("still classifies when Paxos stops quoting the minimum in base units", function () {
      const error = new PaxosTransitApiError(400, "Order amount is below the minimum of $160.93.", "INVALID_ARGUMENT");
      expect(isPaxosTransitAmountBelowMinimumError(error)).to.equal(true);
      expect(getPaxosTransitMinimumOfferAmount(error)).to.equal(undefined);
    });

    it("does not classify other rejections as below-minimum", function () {
      const error = new PaxosTransitApiError(403, "API key is not authorized for this route", "PERMISSION_DENIED");
      expect(isPaxosTransitAmountBelowMinimumError(error)).to.equal(false);
      expect(isPaxosTransitAmountBelowMinimumError(new Error("below the minimum"))).to.equal(false);
    });
  });
});
