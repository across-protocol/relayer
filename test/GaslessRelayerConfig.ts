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
      RELAYER_GASLESS_ALLOWED_INTEGRATOR_IDS: '["0xABCD","1234"]',
    });
    expect(config.allowedIntegratorIds).to.deep.equal(new Set(["0xabcd", "0x1234"]));
    expect(config.blockedIntegratorIds).to.equal(undefined);
  });

  it("parses RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS", function () {
    const config = new GaslessRelayerConfig({
      ...baseEnv,
      RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS: '["DEAD"]',
    });
    expect(config.blockedIntegratorIds).to.deep.equal(new Set(["0xdead"]));
    expect(config.allowedIntegratorIds).to.equal(undefined);
  });

  it("throws for invalid integrator IDs in env", function () {
    expect(
      () =>
        new GaslessRelayerConfig({
          ...baseEnv,
          RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS: '["0xdeadbeef"]',
        })
    ).to.throw('Invalid integrator ID in RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS: "0xdeadbeef"');
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

describe("GaslessRelayerConfig fillsEnabled", function () {
  it("defaults fillsEnabled to true when unset", function () {
    const config = new GaslessRelayerConfig(baseEnv);
    expect(config.fillsEnabled).to.equal(true);
  });

  it("parses RELAYER_GASLESS_FILLS_ENABLED=false", function () {
    const config = new GaslessRelayerConfig({
      ...baseEnv,
      RELAYER_GASLESS_FILLS_ENABLED: "false",
    });
    expect(config.fillsEnabled).to.equal(false);
  });
});

describe("GaslessRelayerConfig address filters", function () {
  it("allows neither allow-list nor block-list to be set", function () {
    const config = new GaslessRelayerConfig(baseEnv);
    expect(config.allowedAddresses).to.equal(undefined);
    expect(config.blockedAddresses).to.equal(undefined);
  });

  it("parses RELAYER_GASLESS_ALLOWED_ADDRESSES case-insensitively", function () {
    const config = new GaslessRelayerConfig({
      ...baseEnv,
      RELAYER_GASLESS_ALLOWED_ADDRESSES: '["0xAbCdEf0123456789AbCdEf0123456789aBcDeF01"]',
    });
    expect(config.allowedAddresses).to.deep.equal(new Set(["0xabcdef0123456789abcdef0123456789abcdef01"]));
    expect(config.blockedAddresses).to.equal(undefined);
  });

  it("parses RELAYER_GASLESS_BLOCKED_ADDRESSES case-insensitively", function () {
    const config = new GaslessRelayerConfig({
      ...baseEnv,
      RELAYER_GASLESS_BLOCKED_ADDRESSES: '["0xAbCdEf0123456789AbCdEf0123456789aBcDeF01"]',
    });
    expect(config.blockedAddresses).to.deep.equal(new Set(["0xabcdef0123456789abcdef0123456789abcdef01"]));
    expect(config.allowedAddresses).to.equal(undefined);
  });

  it("throws for invalid addresses", function () {
    expect(
      () =>
        new GaslessRelayerConfig({
          ...baseEnv,
          RELAYER_GASLESS_BLOCKED_ADDRESSES: '["not-an-address"]',
        })
    ).to.throw('Invalid address in RELAYER_GASLESS_BLOCKED_ADDRESSES: "not-an-address"');
  });

  it("throws when both address filter env vars are set", function () {
    expect(
      () =>
        new GaslessRelayerConfig({
          ...baseEnv,
          RELAYER_GASLESS_ALLOWED_ADDRESSES: '["0x1111111111111111111111111111111111111111"]',
          RELAYER_GASLESS_BLOCKED_ADDRESSES: '["0x2222222222222222222222222222222222222222"]',
        })
    ).to.throw("Only one of RELAYER_GASLESS_ALLOWED_ADDRESSES and RELAYER_GASLESS_BLOCKED_ADDRESSES may be set");
  });
});
