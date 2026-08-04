import { CHAIN_IDs } from "@across-protocol/constants";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalanceRoute } from "./utils/interfaces";

type SupportedToken = "USDC" | "USDT" | "WETH";
type StableToken = Exclude<SupportedToken, "WETH">;
type DifferentAssetAdapter = "binance" | "hyperliquid";

// Direct Binance deposit/withdraw networks for each token. This is intentionally separate from the rebalancer route
// set so we can track venue support without automatically enabling every listed network operationally.
const BINANCE_NETWORKS_BY_SYMBOL: Record<StableToken, readonly number[]> = {
  USDC: [CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BSC, CHAIN_IDs.BASE, CHAIN_IDs.ARBITRUM],
  USDT: [CHAIN_IDs.TRON, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BSC, CHAIN_IDs.AVALANCHE, CHAIN_IDs.ARBITRUM],
};

const REBALANCE_CHAINS_BY_SYMBOL: Record<SupportedToken, readonly number[]> = {
  USDT: [
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.TRON,
    CHAIN_IDs.POLYGON,
    CHAIN_IDs.PLASMA,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.MEGAETH,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.INK,
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.BSC,
    CHAIN_IDs.AVALANCHE,
    CHAIN_IDs.ARBITRUM,
  ],
  USDC: [
    CHAIN_IDs.WORLD_CHAIN,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.POLYGON,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.LINEA,
    CHAIN_IDs.INK,
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.BSC,
    CHAIN_IDs.BASE,
    CHAIN_IDs.AVALANCHE,
    CHAIN_IDs.ARBITRUM,
  ],
  WETH: [CHAIN_IDs.MAINNET],
};

const SAME_ASSET_BRIDGE_ADAPTER_BY_SYMBOL: Record<StableToken, "cctp" | "oft"> = {
  USDC: "cctp",
  USDT: "oft",
};

// Hyperliquid can only use an endpoint when the rebalancer can bridge that token between the endpoint and HyperEVM.
// These catalogs also prevent unsupported same-asset routes from reaching adapter initialization.
const BRIDGE_CHAINS_BY_SYMBOL: Record<StableToken, readonly number[]> = {
  USDC: [
    CHAIN_IDs.WORLD_CHAIN,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.POLYGON,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.LINEA,
    CHAIN_IDs.INK,
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.BASE,
    CHAIN_IDs.AVALANCHE,
    CHAIN_IDs.ARBITRUM,
  ],
  USDT: [
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.POLYGON,
    CHAIN_IDs.PLASMA,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.MEGAETH,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.INK,
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.ARBITRUM,
  ],
};

function configuredChainsForToken(rebalancerConfig: RebalancerConfig, token: SupportedToken): number[] {
  const configuredChains = new Set(
    Object.keys(rebalancerConfig.cumulativeTargetBalances[token]?.chains ?? {}).map(Number)
  );
  return REBALANCE_CHAINS_BY_SYMBOL[token].filter((chainId) => configuredChains.has(chainId));
}

function canUseHyperliquidStablecoinRoute({
  sourceChain,
  sourceToken,
  destinationChain,
  destinationToken,
}: {
  sourceChain: number;
  sourceToken: SupportedToken;
  destinationChain: number;
  destinationToken: SupportedToken;
}): boolean {
  return (
    sourceToken !== "WETH" &&
    destinationToken !== "WETH" &&
    BRIDGE_CHAINS_BY_SYMBOL[sourceToken].includes(sourceChain) &&
    BRIDGE_CHAINS_BY_SYMBOL[destinationToken].includes(destinationChain)
  );
}

function buildSameAssetRouteMatrix(
  token: StableToken,
  chains: readonly number[],
  adapter: "binance" | "cctp" | "oft"
): RebalanceRoute[] {
  return chains.flatMap((sourceChain) =>
    chains
      .filter((destinationChain) => destinationChain !== sourceChain)
      .map((destinationChain) => ({
        sourceChain,
        sourceToken: token,
        destinationChain,
        destinationToken: token,
        adapter,
      }))
  );
}

function buildSameAssetRoutes(rebalancerConfig: RebalancerConfig, token: StableToken): RebalanceRoute[] {
  if (!rebalancerConfig.cumulativeTargetBalances[token]?.targetBalance) {
    return [];
  }
  const configuredChains = configuredChainsForToken(rebalancerConfig, token);
  const bridgeChains = configuredChains.filter((chainId) => BRIDGE_CHAINS_BY_SYMBOL[token].includes(chainId));
  const binanceChains = configuredChains.filter((chainId) => BINANCE_NETWORKS_BY_SYMBOL[token].includes(chainId));
  return [
    ...buildSameAssetRouteMatrix(token, bridgeChains, SAME_ASSET_BRIDGE_ADAPTER_BY_SYMBOL[token]),
    ...buildSameAssetRouteMatrix(token, binanceChains, "binance"),
  ];
}

export function buildBridgeSupportRoutes(rebalanceRoutes: RebalanceRoute[]): RebalanceRoute[] {
  const routes = [...rebalanceRoutes];
  const routeKey = ({ sourceChain, sourceToken, destinationChain, destinationToken, adapter }: RebalanceRoute) =>
    [sourceChain, sourceToken, destinationChain, destinationToken, adapter].join("|");
  const routeKeys = new Set(routes.map(routeKey));
  const addRoute = (token: string, sourceChain: number, destinationChain: number): void => {
    if (token !== "USDT" && token !== "USDC") {
      return;
    }
    const route = {
      sourceChain,
      sourceToken: token,
      destinationChain,
      destinationToken: token,
      adapter: SAME_ASSET_BRIDGE_ADAPTER_BY_SYMBOL[token],
    };
    const key = routeKey(route);
    if (!routeKeys.has(key)) {
      routes.push(route);
      routeKeys.add(key);
    }
  };

  for (const route of rebalanceRoutes) {
    const entrypoint =
      route.adapter === "binance"
        ? CHAIN_IDs.ARBITRUM
        : route.adapter === "hyperliquid"
          ? CHAIN_IDs.HYPEREVM
          : undefined;
    if (entrypoint === undefined) {
      continue;
    }
    const endpoints = [
      [route.sourceToken, route.sourceChain, entrypoint],
      [route.destinationToken, entrypoint, route.destinationChain],
    ] as const;
    for (const [token, sourceChain, destinationChain] of endpoints) {
      const endpointChain: number = sourceChain === entrypoint ? destinationChain : sourceChain;
      const isDirectBinanceRoute =
        route.adapter === "binance" &&
        (token === "USDT" || token === "USDC") &&
        BINANCE_NETWORKS_BY_SYMBOL[token].includes(endpointChain);
      if (endpointChain !== entrypoint && !isDirectBinanceRoute) {
        addRoute(token, sourceChain, destinationChain);
      }
    }
  }
  return routes;
}

type DifferentAssetPairRule = {
  tokenA: SupportedToken;
  tokenB: SupportedToken;
  adapter: DifferentAssetAdapter;
  allow?: (params: {
    sourceChain: number;
    sourceToken: SupportedToken;
    destinationChain: number;
    destinationToken: SupportedToken;
  }) => boolean;
};

const DIFFERENT_ASSET_ROUTE_RULES: readonly DifferentAssetPairRule[] = [
  {
    tokenA: "USDT",
    tokenB: "USDC",
    adapter: "binance",
  },
  {
    tokenA: "USDT",
    tokenB: "USDC",
    adapter: "hyperliquid",
    allow: canUseHyperliquidStablecoinRoute,
  },
  {
    tokenA: "WETH",
    tokenB: "USDT",
    adapter: "binance",
  },
  {
    tokenA: "WETH",
    tokenB: "USDC",
    adapter: "binance",
  },
];

function pushDirectedDifferentAssetRoutes(
  routes: RebalanceRoute[],
  rule: DifferentAssetPairRule,
  sourceToken: SupportedToken,
  sourceChains: readonly number[],
  destinationToken: SupportedToken,
  destinationChains: readonly number[]
): void {
  for (const sourceChain of sourceChains) {
    for (const destinationChain of destinationChains) {
      if (rule.allow && !rule.allow({ sourceChain, sourceToken, destinationChain, destinationToken })) {
        continue;
      }

      routes.push({
        sourceChain,
        sourceToken,
        destinationChain,
        destinationToken,
        adapter: rule.adapter,
      });
    }
  }
}

function buildDifferentAssetRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  const routes: RebalanceRoute[] = [];
  for (const rule of DIFFERENT_ASSET_ROUTE_RULES) {
    if (
      !rebalancerConfig.cumulativeTargetBalances[rule.tokenA]?.targetBalance ||
      !rebalancerConfig.cumulativeTargetBalances[rule.tokenB]?.targetBalance
    ) {
      continue;
    }
    const chainsA = configuredChainsForToken(rebalancerConfig, rule.tokenA);
    const chainsB = configuredChainsForToken(rebalancerConfig, rule.tokenB);
    pushDirectedDifferentAssetRoutes(routes, rule, rule.tokenA, chainsA, rule.tokenB, chainsB);
    pushDirectedDifferentAssetRoutes(routes, rule, rule.tokenB, chainsB, rule.tokenA, chainsA);
  }

  return routes;
}

export function buildRebalanceRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  return [
    ...buildDifferentAssetRoutes(rebalancerConfig),
    ...buildSameAssetRoutes(rebalancerConfig, "USDT"),
    ...buildSameAssetRoutes(rebalancerConfig, "USDC"),
  ];
}
