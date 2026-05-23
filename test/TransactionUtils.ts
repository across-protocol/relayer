import { expect } from "./utils";
import { redactRpcSecrets, sanitizeSimulationReason } from "../src/utils/TransactionUtils";

describe("redactRpcSecrets", function () {
  it("redacts long alphanumeric path segments (API keys)", function () {
    expect(redactRpcSecrets("https://arb-mainnet.g.alchemy.com/v2/kt6OLQDAKLbTH_m5aVlOHPTyg_bbAImP")).to.equal(
      "https://arb-mainnet.g.alchemy.com/v2/<redacted>"
    );
  });

  it("leaves short path components alone", function () {
    expect(redactRpcSecrets("https://example.com/v2/foo")).to.equal("https://example.com/v2/foo");
  });

  it("redacts keys embedded in surrounding text", function () {
    const input = 'url="https://arb-mainnet.g.alchemy.com/v2/kt6OLQDAKLbTH_m5aVlOHPTyg_bbAImP", code=SERVER_ERROR';
    expect(redactRpcSecrets(input)).to.equal(
      'url="https://arb-mainnet.g.alchemy.com/v2/<redacted>", code=SERVER_ERROR'
    );
  });
});

describe("sanitizeSimulationReason", function () {
  it("returns 'unknown error' for empty input", function () {
    expect(sanitizeSimulationReason(undefined)).to.equal("unknown error");
    expect(sanitizeSimulationReason("")).to.equal("unknown error");
  });

  it("passes short reasons through unchanged", function () {
    expect(sanitizeSimulationReason("RelayFilled")).to.equal("RelayFilled");
  });

  it("extracts the inner revert string from a multi-provider aggregate error", function () {
    const noisy =
      "Not enough providers succeeded. Errors:\n" +
      "Provider https://arb-mainnet.g.alchemy.com failed with error: Error: processing response error " +
      '(body="{\\"jsonrpc\\":\\"2.0\\",\\"id\\":71,\\"error\\":{\\"code\\":3,' +
      '\\"message\\":\\"execution reverted: ERC20: burn amount exceeds balance\\",\\"data\\":\\"0x...\\"}}", ' +
      'url="https://arb-mainnet.g.alchemy.com/v2/kt6OLQDAKLbTH_m5aVlOHPTyg_bbAImP", code=SERVER_ERROR)\n' +
      "    at Logger.makeError (/across-relayer/node_modules/@ethersproject/logger/lib/index.js:238:21)";
    expect(sanitizeSimulationReason(noisy)).to.equal("ERC20: burn amount exceeds balance");
  });

  it("redacts secrets even when no revert string is found", function () {
    const noisy =
      "Network request failed against https://arb-mainnet.g.alchemy.com/v2/kt6OLQDAKLbTH_m5aVlOHPTyg_bbAImP";
    expect(sanitizeSimulationReason(noisy)).to.equal(
      "Network request failed against https://arb-mainnet.g.alchemy.com/v2/<redacted>"
    );
  });

  it("caps output length at 200 chars", function () {
    const long = "x".repeat(500);
    expect(sanitizeSimulationReason(long)).to.have.lengthOf(200);
  });
});
