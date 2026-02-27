import { join } from "path";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { toBNWei } from "../src/utils";
import { expect } from "./utils";

describe("RebalancerConfig", () => {
  const READABLE_EXTERNAL_CONFIG_PATH = join(__dirname, "..", "package.json");
  const MISSING_EXTERNAL_CONFIG_PATH = join(__dirname, "fixtures", "does-not-exist.rebalancer.json");

  function makeEnv(overrides: Record<string, string | undefined> = {}): { [key: string]: string | undefined } {
    return {
      HUB_CHAIN_ID: "1",
      ...overrides,
    };
  }

  it("parses cumulative balance targets from valid string config", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        cumulativeTargetBalances: {
          USDC: {
            targetBalance: "100",
            thresholdBalance: "90",
            priorityTier: 2,
            chains: { 1: 0, 10: 1 },
          },
        },
      }),
    });

    const config = new RebalancerConfig(env);

    expect(config.cumulativeTargetBalances.USDC.targetBalance).to.equal(toBNWei("100", 6));
    expect(config.cumulativeTargetBalances.USDC.thresholdBalance).to.equal(toBNWei("90", 6));
    expect(config.cumulativeTargetBalances.USDC.priorityTier).to.equal(2);
    expect(config.cumulativeTargetBalances.USDC.chains).to.deep.equal({ 1: 0, 10: 1 });
  });

  it("throws on invalid config json string", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: "{bad-json",
    });

    expect(() => new RebalancerConfig(env)).to.throw("Rebalancer config error");
  });

  it("derives chainIds from union of target and cumulative chain mappings", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        targetBalances: {
          USDC: {
            10: { targetBalance: "100", thresholdBalance: "90", priorityTier: 0 },
          },
        },
        cumulativeTargetBalances: {
          DAI: {
            targetBalance: "50",
            thresholdBalance: "40",
            priorityTier: 1,
            chains: { 1: 0, 137: 2 },
          },
        },
      }),
    });

    const config = new RebalancerConfig(env);

    expect(new Set(config.chainIds)).to.deep.equal(new Set([1, 10, 137]));
  });

  it("sets maxAmountsToTransfer converted by token decimals for each resolved chain", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        targetBalances: {
          USDC: {
            1: { targetBalance: "100", thresholdBalance: "90", priorityTier: 0 },
            10: { targetBalance: "100", thresholdBalance: "90", priorityTier: 0 },
          },
        },
        maxAmountsToTransfer: {
          USDC: "1000",
          DAI: "2",
        },
      }),
    });

    const config = new RebalancerConfig(env);

    expect(config.maxAmountsToTransfer.USDC[1]).to.equal(toBNWei("1000", 6));
    expect(config.maxAmountsToTransfer.USDC[10]).to.equal(toBNWei("1000", 6));
    expect(config.maxAmountsToTransfer.DAI[1]).to.equal(toBNWei("2", 18));
    expect(config.maxAmountsToTransfer.DAI[10]).to.equal(toBNWei("2", 18));
  });

  it("sets maxPendingOrders from config", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        maxPendingOrders: {
          hyperliquid: 3,
          binance: 5,
        },
      }),
    });

    const config = new RebalancerConfig(env);

    expect(config.maxPendingOrders).to.deep.equal({
      hyperliquid: 3,
      binance: 5,
    });
  });

  it("throws when thresholdBalance is greater than targetBalance in targetBalances", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        targetBalances: {
          USDC: {
            1: { targetBalance: "100", thresholdBalance: "101", priorityTier: 0 },
          },
        },
      }),
    });

    expect(() => new RebalancerConfig(env)).to.throw("thresholdBalance<=targetBalance");
  });

  it("throws when thresholdBalance is greater than targetBalance in cumulativeTargetBalances", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        cumulativeTargetBalances: {
          USDC: {
            targetBalance: "100",
            thresholdBalance: "101",
            priorityTier: 0,
            chains: { 1: 0 },
          },
        },
      }),
    });

    expect(() => new RebalancerConfig(env)).to.throw("thresholdBalance<=targetBalance");
  });

  it("throws when required fields are missing from targetBalances", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        targetBalances: {
          USDC: {
            1: { targetBalance: "100", thresholdBalance: "90" },
          },
        },
      }),
    });

    expect(() => new RebalancerConfig(env)).to.throw("Must specify targetBalance, thresholdBalance, priorityTier");
  });

  it("throws when required fields are missing from cumulativeTargetBalances", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        cumulativeTargetBalances: {
          USDC: {
            targetBalance: "100",
            thresholdBalance: "90",
            chains: { 1: 0 },
          },
        },
      }),
    });

    expect(() => new RebalancerConfig(env)).to.throw(
      "Must specify targetBalance, thresholdBalance, priorityTier for USDC for cumulative target balance"
    );
  });

  it("handles empty or missing config sections without crashing", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({}),
    });

    const config = new RebalancerConfig(env);

    expect(config.targetBalances).to.deep.equal({});
    expect(config.cumulativeTargetBalances).to.deep.equal({});
    expect(config.maxAmountsToTransfer).to.deep.equal({});
    expect(config.maxPendingOrders).to.deep.equal({});
    expect(config.chainIds).to.deep.equal([]);
  });

  it("prefers readable REBALANCER_EXTERNAL_CONFIG over inline REBALANCER_CONFIG", () => {
    const env = makeEnv({
      REBALANCER_EXTERNAL_CONFIG: READABLE_EXTERNAL_CONFIG_PATH,
      REBALANCER_CONFIG: JSON.stringify({
        maxPendingOrders: { adapterFromInline: 1 },
      }),
    });

    const config = new RebalancerConfig(env);

    // package.json does not contain rebalancer config sections, so readable external config wins and yields defaults.
    expect(config.maxPendingOrders).to.deep.equal({});
  });

  it("falls back to inline REBALANCER_CONFIG when REBALANCER_EXTERNAL_CONFIG is unreadable", () => {
    const env = makeEnv({
      REBALANCER_EXTERNAL_CONFIG: MISSING_EXTERNAL_CONFIG_PATH,
      REBALANCER_CONFIG: JSON.stringify({
        maxPendingOrders: { adapterFromInline: 4 },
      }),
    });

    const config = new RebalancerConfig(env);

    expect(config.maxPendingOrders).to.deep.equal({ adapterFromInline: 4 });
  });

  it("throws when REBALANCER_EXTERNAL_CONFIG is unreadable and no inline fallback is provided", () => {
    const env = makeEnv({
      REBALANCER_EXTERNAL_CONFIG: MISSING_EXTERNAL_CONFIG_PATH,
    });

    expect(() => new RebalancerConfig(env)).to.throw(
      "REBALANCER_EXTERNAL_CONFIG is set but file could not be read. Set REBALANCER_CONFIG to use internal config as fallback."
    );
  });

  it("skips maxAmountsToTransfer token-chain pairs that cannot be resolved", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        targetBalances: {
          USDC: {
            1: { targetBalance: "1", thresholdBalance: "0.5", priorityTier: 0 },
          },
        },
        maxAmountsToTransfer: {
          INVALID_TOKEN: "1000",
        },
      }),
    });

    const config = new RebalancerConfig(env);

    expect(config.maxAmountsToTransfer.INVALID_TOKEN).to.deep.equal({});
  });
});
