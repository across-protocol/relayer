import sinon from "sinon";
import { expect } from "chai";
import { winston } from "../src/utils";
import { AcrossApiHttpError, BaseAcrossApiClient } from "../src/clients";

/** Exposes the protected helper under test; the base class is abstract. */
class TestApiClient extends BaseAcrossApiClient {
  constructor(logger: winston.Logger, apiKey?: string) {
    super(logger, "https://api.example.com/api", "TestApiClient", 3000, apiKey);
  }

  post<T>(endpoint: string, body: unknown): Promise<T> {
    return this._postOrThrowWithErrorCode<T>(endpoint, body);
  }
}

describe("BaseAcrossApiClient._postOrThrowWithErrorCode", function () {
  let client: TestApiClient;
  let warnStub: sinon.SinonStub;

  beforeEach(function () {
    warnStub = sinon.stub();
    client = new TestApiClient({ warn: warnStub } as unknown as winston.Logger, "secret-key");
  });

  afterEach(() => sinon.restore());

  it("returns the parsed body on success", async function () {
    sinon.stub(globalThis, "fetch").resolves(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await client.post("some/endpoint", { a: 1 })).to.deep.equal({ ok: true });
  });

  it("sends the bearer token, JSON body and a timeout signal", async function () {
    const fetchStub = sinon.stub(globalThis, "fetch").resolves(new Response("{}", { status: 200 }));
    await client.post("some/endpoint", { a: 1 });
    expect(fetchStub.firstCall.args[0]).to.equal("https://api.example.com/api/some/endpoint");
    const init = fetchStub.firstCall.args[1];
    expect(init?.method).to.equal("POST");
    expect(init?.body).to.equal(JSON.stringify({ a: 1 }));
    expect((init?.headers as Record<string, string>).Authorization).to.equal("Bearer secret-key");
    expect(init?.signal).to.not.equal(undefined);
  });

  it("throws an AcrossApiHttpError carrying the API's code, param and message", async function () {
    sinon.stub(globalThis, "fetch").resolves(
      new Response(
        JSON.stringify({
          type: "AcrossApiError",
          code: "AMOUNT_BELOW_MINIMUM",
          status: 422,
          message: "amount must be >= 5000000 (minimum deposit, 6-dp USDC)",
          param: "amount",
        }),
        { status: 422, statusText: "Unprocessable Entity" }
      )
    );

    const err = await client.post("some/endpoint", {}).then(
      () => undefined,
      (e) => e
    );
    expect(err).to.be.instanceOf(AcrossApiHttpError);
    expect(err.status).to.equal(422);
    expect(err.code).to.equal("AMOUNT_BELOW_MINIMUM");
    expect(err.param).to.equal("amount");
    expect(err.message).to.equal("amount must be >= 5000000 (minimum deposit, 6-dp USDC)");
    // Logged at warn for parity with `_post`/`_postOrThrow`, with the code surfaced for triage.
    expect(warnStub.calledOnce).to.equal(true);
    expect(warnStub.firstCall.args[0].code).to.equal("AMOUNT_BELOW_MINIMUM");
  });

  it("falls back to the status line when the error body is not JSON", async function () {
    sinon
      .stub(globalThis, "fetch")
      .resolves(new Response("<html>gateway</html>", { status: 502, statusText: "Bad Gateway" }));

    const err = await client.post("some/endpoint", {}).then(
      () => undefined,
      (e) => e
    );
    expect(err).to.be.instanceOf(AcrossApiHttpError);
    expect(err.status).to.equal(502);
    expect(err.code).to.equal(undefined);
    expect(err.message).to.equal("HTTP 502: Bad Gateway");
  });

  it("accepts an `error` key as the message fallback", async function () {
    sinon
      .stub(globalThis, "fetch")
      .resolves(new Response(JSON.stringify({ error: "legacy shape" }), { status: 400, statusText: "Bad Request" }));

    const err = await client.post("some/endpoint", {}).then(
      () => undefined,
      (e) => e
    );
    expect(err.message).to.equal("legacy shape");
  });

  it("throws when a successful response is not JSON", async function () {
    sinon.stub(globalThis, "fetch").resolves(new Response("not json", { status: 200 }));
    const err = await client.post("some/endpoint", {}).then(
      () => undefined,
      (e) => e
    );
    expect(err).to.be.instanceOf(Error);
    expect(err).to.not.be.instanceOf(AcrossApiHttpError);
    expect(err.message).to.contain("Expected JSON response");
  });
});
