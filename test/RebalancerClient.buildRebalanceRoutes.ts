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
            [CHAIN_IDs.ARBITRUM]: 0,
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

function buildSyntheticRebalancerConfigWithMainnet(): RebalancerConfig {
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
            [CHAIN_IDs.MAINNET]: 0,
          },
        },
        USDC: {
          targetBalance: "1000",
          thresholdBalance: "500",
          priorityTier: 0,
          chains: {
            [CHAIN_IDs.HYPEREVM]: 0,
            [CHAIN_IDs.ARBITRUM]: 0,
            [CHAIN_IDs.OPTIMISM]: 0,
            [CHAIN_IDs.BSC]: 0,
            [CHAIN_IDs.BASE]: 0,
            [CHAIN_IDs.MAINNET]: 0,
          },
        },
        WETH: {
          targetBalance: "1",
          thresholdBalance: "0.5",
          priorityTier: 0,
          chains: {
            [CHAIN_IDs.MAINNET]: 0,
          },
        },
      },
      maxAmountsToTransfer: {
        USDT: "100",
        USDC: "100",
        WETH: "1",
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
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDC", CHAIN_IDs.BASE, "USDC", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDT", CHAIN_IDs.HYPEREVM, "USDT", "oft")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDT", CHAIN_IDs.HYPEREVM, "USDT", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.HYPEREVM, "USDT", CHAIN_IDs.OPTIMISM, "USDT", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.BSC, "USDT", CHAIN_IDs.OPTIMISM, "USDT", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.BSC, "USDC", CHAIN_IDs.BASE, "USDC", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.HYPEREVM, "USDC", CHAIN_IDs.BASE, "USDC", "binance")).to.equal(false);
  });

  it("does not build WETH Binance routes when mainnet is not configured", async function () {
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

    expect(hasRoute(CHAIN_IDs.MAINNET, "WETH", CHAIN_IDs.HYPEREVM, "USDT", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.HYPEREVM, "USDT", CHAIN_IDs.MAINNET, "WETH", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "WETH", CHAIN_IDs.HYPEREVM, "USDT", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.HYPEREVM, "WETH", CHAIN_IDs.OPTIMISM, "USDT", "binance")).to.equal(false);
  });

  it("builds WETH<->stablecoin routes via binance only from mainnet when mainnet is configured", async function () {
    const config = buildSyntheticRebalancerConfigWithMainnet();

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

    expect(hasRoute(CHAIN_IDs.MAINNET, "WETH", CHAIN_IDs.HYPEREVM, "USDT", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.HYPEREVM, "USDT", CHAIN_IDs.MAINNET, "WETH", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.MAINNET, "WETH", CHAIN_IDs.BASE, "USDC", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.BASE, "USDC", CHAIN_IDs.MAINNET, "WETH", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "WETH", CHAIN_IDs.HYPEREVM, "USDT", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.BSC, "WETH", CHAIN_IDs.BASE, "USDC", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.MAINNET, "WETH", CHAIN_IDs.HYPEREVM, "USDT", "hyperliquid")).to.equal(false);
  });

  it("does not build WETH->WETH Binance routes while WETH support is mainnet-only", async function () {
    const config = buildSyntheticRebalancerConfigWithMainnet();

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

    expect(hasRoute(CHAIN_IDs.MAINNET, "WETH", CHAIN_IDs.MAINNET, "WETH", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "WETH", CHAIN_IDs.MAINNET, "WETH", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.MAINNET, "WETH", CHAIN_IDs.OPTIMISM, "WETH", "binance")).to.equal(false);
  });
});
