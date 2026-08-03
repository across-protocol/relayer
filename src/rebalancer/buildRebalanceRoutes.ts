import { CHAIN_IDs } from "@across-protocol/constants";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalanceRoute } from "./utils/interfaces";

type SupportedToken = "USDC" | "USDT" | "WETH";
type StableToken = Exclude<SupportedToken, "WETH">;
type DifferentAssetAdapter = "binance" | "hyperliquid";

// Direct Binance deposit/withdraw networks for each token. This is intentionally separate from the rebalancer route
// set so we can track venue support without automatically enabling every listed network operationally.
const BINANCE_NETWORKS_BY_SYMBOL: Record<StableToken, readonly number[]> = {
  USDC: [CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BASE, CHAIN_IDs.BSC],
  USDT: [CHAIN_IDs.ARBITRUM, CHAIN_IDs.AVALANCHE, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BSC, CHAIN_IDs.TRON],
};

const REBALANCE_CHAINS_BY_SYMBOL: Record<SupportedToken, readonly number[]> = {
  USDT: [
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.POLYGON,
    CHAIN_IDs.MEGAETH,
    CHAIN_IDs.PLASMA,
    CHAIN_IDs.AVALANCHE,
    CHAIN_IDs.INK,
    CHAIN_IDs.BSC,
    CHAIN_IDs.TRON,
  ],
  USDC: [
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.BASE,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.POLYGON,
    CHAIN_IDs.WORLD_CHAIN,
    CHAIN_IDs.AVALANCHE,
    CHAIN_IDs.INK,
    CHAIN_IDs.LINEA,
    CHAIN_IDs.BSC,
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
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.AVALANCHE,
    CHAIN_IDs.BASE,
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.INK,
    CHAIN_IDs.LINEA,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.POLYGON,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.WORLD_CHAIN,
  ],
  USDT: [
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.INK,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.MEGAETH,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.PLASMA,
    CHAIN_IDs.POLYGON,
    CHAIN_IDs.UNICHAIN,
  ],
};

const REQUIRED_BRIDGE_ENTRYPOINT_CHAINS = [CHAIN_IDs.ARBITRUM, CHAIN_IDs.HYPEREVM] as const;

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

function buildSameAssetBridgeRoutes(token: StableToken, chains: readonly number[]): RebalanceRoute[] {
  const bridgeChains = chains.filter((chainId) => BRIDGE_CHAINS_BY_SYMBOL[token].includes(chainId));
  return bridgeChains.flatMap((sourceChain) =>
    bridgeChains
      .filter((destinationChain) => destinationChain !== sourceChain)
      .map((destinationChain) => ({
        sourceChain,
        sourceToken: token,
        destinationChain,
        destinationToken: token,
        adapter: SAME_ASSET_BRIDGE_ADAPTER_BY_SYMBOL[token],
      }))
  );
}

function buildSameAssetRoutes(rebalancerConfig: RebalancerConfig, token: StableToken): RebalanceRoute[] {
  if (!rebalancerConfig.cumulativeTargetBalances[token]?.targetBalance) {
    return [];
  }
  const configuredChains = configuredChainsForToken(rebalancerConfig, token);
  const directBinanceNetworks = new Set(BINANCE_NETWORKS_BY_SYMBOL[token]);
  const routes = buildSameAssetBridgeRoutes(token, configuredChains);

  for (const sourceChain of configuredChains) {
    for (const destinationChain of configuredChains) {
      if (sourceChain === destinationChain) {
        continue;
      }

      if (directBinanceNetworks.has(sourceChain) && directBinanceNetworks.has(destinationChain)) {
        routes.push({
          sourceChain,
          sourceToken: token,
          destinationChain,
          destinationToken: token,
          adapter: "binance",
        });
      }
    }
  }

  return routes;
}

export function buildBridgeSupportRoutes(
  rebalancerConfig: RebalancerConfig,
  rebalanceRoutes: RebalanceRoute[] = []
): RebalanceRoute[] {
  const requiredRoutes = (["USDT", "USDC"] as const).flatMap((token) => {
    const configuredBridgeChains = configuredChainsForToken(rebalancerConfig, token).filter((chainId) =>
      BRIDGE_CHAINS_BY_SYMBOL[token].includes(chainId)
    );
    if (configuredBridgeChains.length === 0) {
      return [];
    }
    return buildSameAssetBridgeRoutes(
      token,
      Array.from(new Set([...configuredBridgeChains, ...REQUIRED_BRIDGE_ENTRYPOINT_CHAINS]))
    );
  });
  return [...rebalanceRoutes, ...requiredRoutes];
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
