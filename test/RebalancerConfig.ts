import { join } from "path";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { toBNWei } from "../src/utils";
import { expect } from "./utils";

describe("RebalancerConfig", () => {
  const READABLE_EXTERNAL_CONFIG_PATH = join(__dirname, "..", "package.json");
  const MISSING_EXTERNAL_CONFIG_PATH = join(__dirname, "fixtures", "does-not-exist.rebalancer.json");

  function buildCumulativeTargetBalanceConfig(
    targetBalance: string,
    thresholdBalanceLower: string,
    deficitPriorityTier: number,
    rebalanceRoutePreferencesConfig: { sortedExcessSinks: number[]; sortedDeficitSources: number[] },
    excessPriorityTier = deficitPriorityTier,
    thresholdBalanceUpper = targetBalance
  ) {
    return {
      targetBalanceConfig: {
        targetBalance,
        thresholdBalanceLower,
        thresholdBalanceUpper,
        deficitPriorityTier,
        excessPriorityTier,
      },
      rebalanceRoutePreferencesConfig,
    };
  }

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
          USDC: buildCumulativeTargetBalanceConfig("100", "90", 2, {
            sortedExcessSinks: [1, 10],
            sortedDeficitSources: [1, 10],
          }),
        },
      }),
    });

    const config = new RebalancerConfig(env);

    expect(config.cumulativeTargetBalances.USDC.targetBalanceConfig.targetBalance).to.equal(toBNWei("100", 6));
    expect(config.cumulativeTargetBalances.USDC.targetBalanceConfig.thresholdBalanceLower).to.equal(toBNWei("90", 6));
    expect(config.cumulativeTargetBalances.USDC.targetBalanceConfig.thresholdBalanceUpper).to.equal(toBNWei("100", 6));
    expect(config.cumulativeTargetBalances.USDC.targetBalanceConfig.deficitPriorityTier).to.equal(2);
    expect(config.cumulativeTargetBalances.USDC.targetBalanceConfig.excessPriorityTier).to.equal(2);
    expect(config.cumulativeTargetBalances.USDC.rebalanceRoutePreferencesConfig).to.deep.equal({
      sortedExcessSinks: [1, 10],
      sortedDeficitSources: [1, 10],
    });
  });

  it("throws on invalid config json string", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: "{bad-json",
    });

    expect(() => new RebalancerConfig(env)).to.throw("Rebalancer config error");
  });

  it("derives chainIds from union of cumulative chain mappings", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        cumulativeTargetBalances: {
          DAI: buildCumulativeTargetBalanceConfig("50", "40", 1, {
            sortedExcessSinks: [1],
            sortedDeficitSources: [137],
          }),
          USDC: buildCumulativeTargetBalanceConfig("100", "90", 0, {
            sortedExcessSinks: [10],
            sortedDeficitSources: [],
          }),
        },
      }),
    });

    const config = new RebalancerConfig(env);

    expect(new Set(config.chainIds)).to.deep.equal(new Set([1, 10, 137]));
  });

  it("sets maxAmountsToTransfer converted by token decimals for each resolved chain", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        cumulativeTargetBalances: {
          USDC: buildCumulativeTargetBalanceConfig("100", "90", 0, {
            sortedExcessSinks: [1],
            sortedDeficitSources: [10],
          }),
          DAI: buildCumulativeTargetBalanceConfig("100", "90", 0, {
            sortedExcessSinks: [1],
            sortedDeficitSources: [10],
          }),
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

  it("throws when thresholdBalance is greater than targetBalance in cumulativeTargetBalances", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        cumulativeTargetBalances: {
          USDC: buildCumulativeTargetBalanceConfig("100", "101", 0, {
            sortedExcessSinks: [1],
            sortedDeficitSources: [],
          }),
        },
      }),
    });

    expect(() => new RebalancerConfig(env)).to.throw("thresholdBalanceLower<=targetBalance<=thresholdBalanceUpper");
  });

  it("throws when required fields are missing from cumulativeTargetBalances", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({
        cumulativeTargetBalances: {
          USDC: {
            targetBalanceConfig: {
              targetBalance: "100",
              thresholdBalanceLower: "90",
              thresholdBalanceUpper: "100",
            },
            rebalanceRoutePreferencesConfig: {
              sortedExcessSinks: [1],
              sortedDeficitSources: [1],
            },
          },
        },
      }),
    });

    expect(() => new RebalancerConfig(env)).to.throw(
      "Must specify targetBalance, thresholdBalanceLower, thresholdBalanceUpper, deficitPriorityTier, excessPriorityTier for USDC for cumulative target balance"
    );
  });

  it("handles empty or missing config sections without crashing", () => {
    const env = makeEnv({
      REBALANCER_CONFIG: JSON.stringify({}),
    });

    const config = new RebalancerConfig(env);

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
        cumulativeTargetBalances: {
          USDC: buildCumulativeTargetBalanceConfig("1", "0.5", 0, {
            sortedExcessSinks: [1],
            sortedDeficitSources: [],
          }),
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
