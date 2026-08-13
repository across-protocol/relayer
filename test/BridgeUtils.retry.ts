import { CHAIN_IDs } from "@across-protocol/constants";
import { BridgeApiClient } from "../src/utils/BridgeUtils";
import { retryBackoffS } from "../src/utils/ExecutionUtils";
import * as sdkUtils from "../src/utils/SDKUtils";
import { expect, sinon } from "./utils";

describe("retryBackoffS", function () {
  it("waits at least one second and grows exponentially", function () {
    [0, 1, 2, 3].forEach((attempt) => {
      const backoffS = retryBackoffS(attempt);
      expect(backoffS).to.be.at.least(2 ** attempt);
      expect(backoffS).to.be.below(2 ** attempt + 1);
    });
  });

  it("respects a custom base", function () {
    expect(retryBackoffS(2, 3)).to.be.at.least(9);
    expect(retryBackoffS(2, 3)).to.be.below(10);
  });
});

describe("BridgeApiClient: retries", function () {
  const nRetries = 2;
  let client: BridgeApiClient;
  let delayStub: sinon.SinonStub;

  beforeEach(function () {
    client = new BridgeApiClient(
      "https://mock-bridge-api.test",
      "test-api-key",
      "test-customer-id",
      CHAIN_IDs.MAINNET,
      CHAIN_IDs.TEMPO,
      undefined,
      nRetries
    );
    delayStub = sinon.stub(sdkUtils, "delay").resolves();
  });

  afterEach(function () {
    sinon.restore();
  });

  it("backs off exponentially before each retry, then rethrows", async function () {
    const fetchStub = sinon.stub(sdkUtils, "fetchWithTimeout").rejects(new Error("HTTP 500: Internal Server Error"));

    await expect(client.getWithRetry("v0/transfers", {})).to.be.rejectedWith("HTTP 500");

    // One initial attempt plus one per retry, with a backoff preceding each retry but not the final throw.
    expect(fetchStub.callCount).to.equal(nRetries + 1);
    const backoffsS = delayStub.args.map(([backoffS]) => backoffS);
    expect(backoffsS.length).to.equal(nRetries);
    expect(backoffsS[0]).to.be.at.least(1);
    expect(backoffsS[1]).to.be.at.least(2);
  });

  it("does not sleep when the request succeeds", async function () {
    sinon.stub(sdkUtils, "fetchWithTimeout").resolves({ data: [] });

    await client.getWithRetry("v0/transfers", {});
    expect(delayStub.notCalled).to.be.true;
  });
});
