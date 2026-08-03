import { expect } from "./utils";
import { CHAIN_IDs } from "../src/utils";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { buildRebalanceRoutes } from "../src/rebalancer/buildRebalanceRoutes";
import {
  buildSameAssetRebalanceRoutes,
  SAME_ASSET_REBALANCE_ROUTE_SUPPORT,
  type SameAssetRebalanceRouteSupport,
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

const FULL_MATRIX_USDT_CHAINS = [
  CHAIN_IDs.MAINNET,
  CHAIN_IDs.OPTIMISM,
  CHAIN_IDs.UNICHAIN,
  CHAIN_IDs.POLYGON,
  CHAIN_IDs.MONAD,
  CHAIN_IDs.HYPEREVM,
  CHAIN_IDs.MEGAETH,
  CHAIN_IDs.PLASMA,
  CHAIN_IDs.ARBITRUM,
  CHAIN_IDs.AVALANCHE,
  CHAIN_IDs.INK,
  CHAIN_IDs.BSC,
  CHAIN_IDs.TRON,
] as const;

const FULL_MATRIX_USDC_CHAINS = [
  CHAIN_IDs.MAINNET,
  CHAIN_IDs.OPTIMISM,
  CHAIN_IDs.UNICHAIN,
  CHAIN_IDs.POLYGON,
  CHAIN_IDs.MONAD,
  CHAIN_IDs.WORLD_CHAIN,
  CHAIN_IDs.HYPEREVM,
  CHAIN_IDs.BASE,
  CHAIN_IDs.ARBITRUM,
  CHAIN_IDs.AVALANCHE,
  CHAIN_IDs.INK,
  CHAIN_IDs.LINEA,
  CHAIN_IDs.BSC,
] as const;

const HYPERLIQUID_USDT_CHAINS = FULL_MATRIX_USDT_CHAINS.filter(
  (chainId) => ![CHAIN_IDs.AVALANCHE, CHAIN_IDs.BSC, CHAIN_IDs.TRON].includes(chainId)
);
const HYPERLIQUID_USDC_CHAINS = FULL_MATRIX_USDC_CHAINS.filter((chainId) => chainId !== CHAIN_IDs.BSC);

function buildFullMatrixRebalancerConfig(): RebalancerConfig {
  const chains = (chainIds: readonly number[]) => Object.fromEntries(chainIds.map((chainId) => [chainId, 0]));
  return new RebalancerConfig({
    HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
    REBALANCER_CONFIG: JSON.stringify({
      cumulativeTargetBalances: {
        USDT: {
          targetBalance: "1000",
          thresholdBalance: "500",
          priorityTier: 0,
          chains: chains(FULL_MATRIX_USDT_CHAINS),
        },
        USDC: {
          targetBalance: "1000",
          thresholdBalance: "500",
          priorityTier: 0,
          chains: chains(FULL_MATRIX_USDC_CHAINS),
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

function buildSyntheticSameAssetRebalancerConfig(
  supportedRoutes: readonly SameAssetRebalanceRouteSupport[]
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

const EXPECTED_SAME_ASSET_ROUTES = SAME_ASSET_REBALANCE_ROUTE_SUPPORT.map(({ token, chainId, adapter }) => ({
  sourceChain: CHAIN_IDs.MAINNET,
  destinationChain: chainId,
  sourceToken: token,
  destinationToken: token,
  adapter,
}));

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
    expect(hasRoute(CHAIN_IDs.ARBITRUM, "USDT", CHAIN_IDs.OPTIMISM, "USDC", "binance")).to.equal(false);
    expect(hasRoute(CHAIN_IDs.BASE, "USDC", CHAIN_IDs.ARBITRUM, "USDT", "binance")).to.equal(false);
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

  it("builds direct Binance routes for a USDT-only Mainnet and Avalanche config", function () {
    const config = buildFullMatrixRebalancerConfig();
    delete config.cumulativeTargetBalances.USDC;
    const routes = buildRebalanceRoutes(config);

    expect(routeExists(routes, CHAIN_IDs.MAINNET, "USDT", CHAIN_IDs.AVALANCHE, "USDT", "binance")).to.equal(true);
    expect(routeExists(routes, CHAIN_IDs.AVALANCHE, "USDT", CHAIN_IDs.MAINNET, "USDT", "binance")).to.equal(true);
    expect(routeExists(routes, CHAIN_IDs.MAINNET, "USDT", CHAIN_IDs.AVALANCHE, "USDT", "oft")).to.equal(false);
    expect(routeExists(routes, CHAIN_IDs.AVALANCHE, "USDT", CHAIN_IDs.MAINNET, "USDT", "oft")).to.equal(false);
  });

  it("covers every configured cross-chain USDT<->USDC route with Binance", function () {
    const routes = buildRebalanceRoutes(buildFullMatrixRebalancerConfig());
    const matrixRoutes = [
      ...FULL_MATRIX_USDT_CHAINS.flatMap((sourceChain) =>
        FULL_MATRIX_USDC_CHAINS.filter((destinationChain) => destinationChain !== sourceChain).map(
          (destinationChain) => [sourceChain, "USDT", destinationChain, "USDC"] as const
        )
      ),
      ...FULL_MATRIX_USDC_CHAINS.flatMap((sourceChain) =>
        FULL_MATRIX_USDT_CHAINS.filter((destinationChain) => destinationChain !== sourceChain).map(
          (destinationChain) => [sourceChain, "USDC", destinationChain, "USDT"] as const
        )
      ),
    ];

    expect(matrixRoutes).to.have.lengthOf(318);
    matrixRoutes.forEach(([sourceChain, sourceToken, destinationChain, destinationToken]) => {
      expect(routeExists(routes, sourceChain, sourceToken, destinationChain, destinationToken, "binance")).to.equal(
        true,
        `missing Binance route ${sourceChain} ${sourceToken} -> ${destinationChain} ${destinationToken}`
      );
    });
  });

  it("only builds Hyperliquid routes whose token endpoints can bridge through HyperEVM", function () {
    const routes = buildRebalanceRoutes(buildFullMatrixRebalancerConfig());
    const hyperliquidRoutes = routes.filter(
      ({ sourceChain, sourceToken, destinationChain, destinationToken, adapter }) =>
        adapter === "hyperliquid" &&
        sourceChain !== destinationChain &&
        ((sourceToken === "USDT" && destinationToken === "USDC") ||
          (sourceToken === "USDC" && destinationToken === "USDT"))
    );

    expect(hyperliquidRoutes).to.have.lengthOf(224);
    hyperliquidRoutes.forEach(({ sourceChain, sourceToken, destinationChain, destinationToken }) => {
      const supportedSourceChains = sourceToken === "USDT" ? HYPERLIQUID_USDT_CHAINS : HYPERLIQUID_USDC_CHAINS;
      const supportedDestinationChains =
        destinationToken === "USDT" ? HYPERLIQUID_USDT_CHAINS : HYPERLIQUID_USDC_CHAINS;
      expect(supportedSourceChains).to.include(sourceChain);
      expect(supportedDestinationChains).to.include(destinationChain);
    });

    for (const unsupportedUsdtChain of [CHAIN_IDs.AVALANCHE, CHAIN_IDs.BSC, CHAIN_IDs.TRON]) {
      expect(routeExists(routes, unsupportedUsdtChain, "USDT", CHAIN_IDs.LINEA, "USDC", "hyperliquid")).to.equal(false);
      expect(routeExists(routes, CHAIN_IDs.LINEA, "USDC", unsupportedUsdtChain, "USDT", "hyperliquid")).to.equal(false);
    }
    expect(routeExists(routes, CHAIN_IDs.BSC, "USDC", CHAIN_IDs.MEGAETH, "USDT", "hyperliquid")).to.equal(false);
    expect(routeExists(routes, CHAIN_IDs.MEGAETH, "USDT", CHAIN_IDs.BSC, "USDC", "hyperliquid")).to.equal(false);
  });

  it("does not advertise unsupported same-asset bridge endpoints", function () {
    const routes = buildRebalanceRoutes(buildFullMatrixRebalancerConfig());

    for (const unsupportedUsdtChain of [CHAIN_IDs.AVALANCHE, CHAIN_IDs.BSC, CHAIN_IDs.TRON]) {
      expect(routeExists(routes, unsupportedUsdtChain, "USDT", CHAIN_IDs.MEGAETH, "USDT", "oft")).to.equal(false);
      expect(routeExists(routes, CHAIN_IDs.MEGAETH, "USDT", unsupportedUsdtChain, "USDT", "oft")).to.equal(false);
    }
    expect(routeExists(routes, CHAIN_IDs.BSC, "USDC", CHAIN_IDs.LINEA, "USDC", "cctp")).to.equal(false);
    expect(routeExists(routes, CHAIN_IDs.LINEA, "USDC", CHAIN_IDs.BSC, "USDC", "cctp")).to.equal(false);
    expect(routeExists(routes, CHAIN_IDs.MEGAETH, "USDT", CHAIN_IDs.INK, "USDT", "oft")).to.equal(true);
    expect(routeExists(routes, CHAIN_IDs.WORLD_CHAIN, "USDC", CHAIN_IDs.LINEA, "USDC", "cctp")).to.equal(true);
  });
});

describe("buildSameAssetRebalanceRoutes", function () {
  it("builds exactly the configured forward routes in the SameAsset support catalog", function () {
    const routes = buildSameAssetRebalanceRoutes(
      buildSyntheticSameAssetRebalancerConfig(SAME_ASSET_REBALANCE_ROUTE_SUPPORT)
    );

    expect(SAME_ASSET_REBALANCE_ROUTE_SUPPORT).not.to.have.lengthOf(0);
    expect(routes).to.deep.equal(EXPECTED_SAME_ASSET_ROUTES);
  });

  it("filters each supported route when it is disabled in rebalancer config", function () {
    expect(SAME_ASSET_REBALANCE_ROUTE_SUPPORT).not.to.have.lengthOf(0);
    SAME_ASSET_REBALANCE_ROUTE_SUPPORT.forEach((disabledRoute) => {
      const enabledSupport = SAME_ASSET_REBALANCE_ROUTE_SUPPORT.filter(
        ({ token, chainId }) => token !== disabledRoute.token || chainId !== disabledRoute.chainId
      );
      const expectedEnabledRoutes = EXPECTED_SAME_ASSET_ROUTES.filter(
        ({ sourceToken, destinationChain }) =>
          sourceToken !== disabledRoute.token || destinationChain !== disabledRoute.chainId
      );

      expect(buildSameAssetRebalanceRoutes(buildSyntheticSameAssetRebalancerConfig(enabledSupport))).to.deep.equal(
        expectedEnabledRoutes
      );
    });
  });
});
