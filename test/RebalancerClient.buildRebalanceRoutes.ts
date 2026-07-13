import { expect } from "./utils";
import { CHAIN_IDs } from "../src/utils";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { buildRebalanceRoutes } from "../src/rebalancer/buildRebalanceRoutes";
import {
  buildSameAssetRebalanceRoutes,
  getSameAssetRebalanceRouteSupport,
} from "../src/rebalancer/buildSameAssetRebalanceRoutes";

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

function buildSyntheticRebalancerConfigWithTron(): RebalancerConfig {
  return new RebalancerConfig({
    HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
    REBALANCER_CONFIG: JSON.stringify({
      cumulativeTargetBalances: {
        USDT: {
          targetBalance: "1000",
          thresholdBalance: "500",
          priorityTier: 0,
          chains: {
            [CHAIN_IDs.TRON]: 0,
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
            [CHAIN_IDs.BASE]: 0,
            [CHAIN_IDs.OPTIMISM]: 0,
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

type SameAssetRouteSupport = ReturnType<typeof getSameAssetRebalanceRouteSupport>[number];

function buildSyntheticSameAssetRebalancerConfig(
  supportedRoutes: readonly SameAssetRouteSupport[] = getSameAssetRebalanceRouteSupport()
): RebalancerConfig {
  const sameAssetBalances = supportedRoutes.reduce<Record<string, { chains: Record<number, number> }>>(
    (balances, { token, chainId }) => {
      balances[token] ??= { chains: {} };
      balances[token].chains[chainId] = 0;
      return balances;
    },
    {}
  );

  return new RebalancerConfig({
    HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
    REBALANCER_CONFIG: JSON.stringify({
      sameAssetBalances,
    }),
  });
}

function routeExists(
  routes: ReturnType<typeof buildRebalanceRoutes>,
  sourceChain: number,
  sourceToken: string,
  destinationChain: number,
  destinationToken: string,
  adapter: string
): boolean {
  return routes.some(
    (route) =>
      route.sourceChain === sourceChain &&
      route.sourceToken === sourceToken &&
      route.destinationChain === destinationChain &&
      route.destinationToken === destinationToken &&
      route.adapter === adapter
  );
}

describe("buildRebalanceRoutes", function () {
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
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDC", CHAIN_IDs.BASE, "USDC", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDT", CHAIN_IDs.HYPEREVM, "USDT", "oft")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDT", CHAIN_IDs.HYPEREVM, "USDT", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.HYPEREVM, "USDT", CHAIN_IDs.OPTIMISM, "USDT", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.BSC, "USDT", CHAIN_IDs.OPTIMISM, "USDT", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.BSC, "USDC", CHAIN_IDs.BASE, "USDC", "binance")).to.equal(true);
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

  it("builds Tron USDT Binance routes without adding Tron Hyperliquid or OFT routes", async function () {
    const config = buildSyntheticRebalancerConfigWithTron();

    const routes = buildRebalanceRoutes(config);
    const hasRoute = (
      sourceChain: number,
      sourceToken: string,
      destinationChain: number,
      destinationToken: string,
      adapter: string
    ) => routeExists(routes, sourceChain, sourceToken, destinationChain, destinationToken, adapter);

    expect(hasRoute(CHAIN_IDs.TRON, "USDT", CHAIN_IDs.BASE, "USDC", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.BASE, "USDC", CHAIN_IDs.TRON, "USDT", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.TRON, "USDT", CHAIN_IDs.OPTIMISM, "USDT", "binance")).to.equal(true);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDT", CHAIN_IDs.TRON, "USDT", "binance")).to.equal(true);

    expect(hasRoute(CHAIN_IDs.TRON, "USDT", CHAIN_IDs.BASE, "USDC", "hyperliquid")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.BASE, "USDC", CHAIN_IDs.TRON, "USDT", "hyperliquid")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.TRON, "USDT", CHAIN_IDs.OPTIMISM, "USDT", "oft")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.OPTIMISM, "USDT", CHAIN_IDs.TRON, "USDT", "oft")).to.equal(false);
  });
});

describe("buildSameAssetRebalanceRoutes", function () {
  it("builds every configured route in the SameAsset support catalog", function () {
    const supportedRoutes = getSameAssetRebalanceRouteSupport();
    const routes = buildSameAssetRebalanceRoutes(buildSyntheticSameAssetRebalancerConfig(supportedRoutes));
    const expectedRoutes = supportedRoutes.map(({ token, chainId, adapter }) => ({
      sourceChain: CHAIN_IDs.MAINNET,
      destinationChain: chainId,
      sourceToken: token,
      destinationToken: token,
      adapter,
    }));

    expect(supportedRoutes).not.to.have.lengthOf(0);
    expect(routes).to.have.lengthOf(expectedRoutes.length);
    expect(routes).to.have.deep.members(expectedRoutes);
    expectedRoutes.forEach((route) => {
      expect(
        routeExists(
          routes,
          route.destinationChain,
          route.destinationToken,
          route.sourceChain,
          route.sourceToken,
          route.adapter
        )
      ).to.equal(false);
    });
  });

  it("filters each supported route when it is disabled in rebalancer config", function () {
    const supportedRoutes = getSameAssetRebalanceRouteSupport();

    expect(supportedRoutes).not.to.have.lengthOf(0);
    supportedRoutes.forEach((disabledRoute) => {
      const enabledRoutes = supportedRoutes.filter(
        ({ token, chainId }) => token !== disabledRoute.token || chainId !== disabledRoute.chainId
      );
      const routes = buildSameAssetRebalanceRoutes(buildSyntheticSameAssetRebalancerConfig(enabledRoutes));

      expect(
        routeExists(
          routes,
          CHAIN_IDs.MAINNET,
          disabledRoute.token,
          disabledRoute.chainId,
          disabledRoute.token,
          disabledRoute.adapter
        )
      ).to.equal(false);
      enabledRoutes.forEach(({ token, chainId, adapter }) => {
        expect(routeExists(routes, CHAIN_IDs.MAINNET, token, chainId, token, adapter)).to.equal(true);
      });
    });
  });
});
