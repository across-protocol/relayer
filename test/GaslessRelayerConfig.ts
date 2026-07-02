import { GaslessRelayerConfig } from "../src/gasless/GaslessRelayerConfig";
import { expect } from "./utils";

const baseEnv = {
  RELAYER_TOKEN_SYMBOLS: '["USDC"]',
  RELAYER_ORIGIN_CHAINS: "[1]",
  RELAYER_DESTINATION_CHAINS: "[8453]",
  API_GASLESS_ENDPOINT: "http://127.0.0.1",
};

describe("GaslessRelayerConfig integrator filters", function () {
  it("allows neither allow-list nor block-list to be set", function () {
    const config = new GaslessRelayerConfig(baseEnv);
    expect(config.allowedIntegratorIds).to.equal(undefined);
    expect(config.blockedIntegratorIds).to.equal(undefined);
  });

  it("parses RELAYER_GASLESS_ALLOWED_INTEGRATOR_IDS", function () {
    const config = new GaslessRelayerConfig({
      ...baseEnv,
      RELAYER_GASLESS_ALLOWED_INTEGRATOR_IDS: '["0xABCD","0x1234"]',
    });
    expect(config.allowedIntegratorIds).to.deep.equal(new Set(["0xabcd", "0x1234"]));
    expect(config.blockedIntegratorIds).to.equal(undefined);
  });

  it("parses RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS", function () {
    const config = new GaslessRelayerConfig({
      ...baseEnv,
      RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS: '["0xdead"]',
    });
    expect(config.blockedIntegratorIds).to.deep.equal(new Set(["0xdead"]));
    expect(config.allowedIntegratorIds).to.equal(undefined);
  });

  it("throws when both integrator filter env vars are set", function () {
    expect(
      () =>
        new GaslessRelayerConfig({
          ...baseEnv,
          RELAYER_GASLESS_ALLOWED_INTEGRATOR_IDS: '["0xabcd"]',
          RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS: '["0xdead"]',
        })
    ).to.throw(
      "Only one of RELAYER_GASLESS_ALLOWED_INTEGRATOR_IDS and RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS may be set"
    );
  });
});
