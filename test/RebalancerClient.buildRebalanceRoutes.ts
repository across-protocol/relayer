import { expect } from "./utils";
import { CHAIN_IDs } from "../src/utils";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { buildRebalanceRoutes } from "../src/rebalancer/buildRebalanceRoutes";

function buildSyntheticRebalancerConfig(): RebalancerConfig {
  return new RebalancerConfig({
    HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
    REBALANCER_CONFIG: JSON.stringify({
      cumulativeTargetBalances: {
        USDT: {
          targetBalance: "1000",
          thresholdBalance: "500",
          priorityTier: 0,
          chains: {
            [CHAIN_IDs.HYPEREVM]: 0,
            [CHAIN_IDs.OPTIMISM]: 0,
            [CHAIN_IDs.BSC]: 0,
          },
        },
        USDC: {
          targetBalance: "1000",
          thresholdBalance: "500",
          priorityTier: 0,
          chains: {
            [CHAIN_IDs.HYPEREVM]: 0,
            [CHAIN_IDs.OPTIMISM]: 0,
            [CHAIN_IDs.BSC]: 0,
            [CHAIN_IDs.BASE]: 0,
          },
        },
      },
      maxAmountsToTransfer: {
        USDT: "100",
        USDC: "100",
      },
      maxPendingOrders: {
        hyperliquid: 3,
        binance: 3,
      },
    }),
  });
}

describe("buildRebalanceRoutes", async function () {
  it("builds the exact stablecoin route families implied by synthetic config", async function () {
    const config = buildSyntheticRebalancerConfig();

    const routes = buildRebalanceRoutes(config);
    const hasRoute = (
      sourceChain: number,
      sourceToken: string,
      destinationChain: number,
      destinationToken: string,
      adapter: string
    ) =>
      routes.some(
        (route) =>
          route.sourceChain === sourceChain &&
          route.sourceToken === sourceToken &&
          route.destinationChain === destinationChain &&
          route.destinationToken === destinationToken &&
          route.adapter === adapter
      );

    expect(hasRoute(CHAIN_IDs.HYPEREVM, "USDT", CHAIN_IDs.OPTIMISM, "USDC", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.HYPEREVM, "USDT", CHAIN_IDs.OPTIMISM, "USDC", "hyperliquid")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.BSC, "USDT", CHAIN_IDs.OPTIMISM, "USDC", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.BSC, "USDT", CHAIN_IDs.OPTIMISM, "USDC", "hyperliquid")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDC", CHAIN_IDs.BASE, "USDC", "cctp")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDT", CHAIN_IDs.HYPEREVM, "USDT", "oft")).to.equal(true);
  });

  it("builds WETH<->stablecoin routes via binance for direct Binance ETH networks", async function () {
    const config = buildSyntheticRebalancerConfig();

    const routes = buildRebalanceRoutes(config);
    const hasRoute = (
      sourceChain: number,
      sourceToken: string,
      destinationChain: number,
      destinationToken: string,
      adapter: string
    ) =>
      routes.some(
        (route) =>
          route.sourceChain === sourceChain &&
          route.sourceToken === sourceToken &&
          route.destinationChain === destinationChain &&
          route.destinationToken === destinationToken &&
          route.adapter === adapter
      );

    // WETH routes should exist for Binance-supported ETH chains paired with stablecoin chains.
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "WETH", CHAIN_IDs.HYPEREVM, "USDT", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.HYPEREVM, "USDT", CHAIN_IDs.OPTIMISM, "WETH", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.BSC, "WETH", CHAIN_IDs.BASE, "USDC", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.BASE, "USDC", CHAIN_IDs.BSC, "WETH", "binance")).to.equal(true);

    // WETH routes should only use binance, not hyperliquid.
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "WETH", CHAIN_IDs.HYPEREVM, "USDT", "hyperliquid")).to.equal(false);

    // HyperEVM is not a direct Binance ETH network, so no WETH routes sourced from it.
    expect(hasRoute(CHAIN_IDs.HYPEREVM, "WETH", CHAIN_IDs.OPTIMISM, "USDT", "binance")).to.equal(false);
  });
});
