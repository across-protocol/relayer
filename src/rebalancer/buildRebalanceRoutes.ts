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
  USDT: [CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BSC, CHAIN_IDs.TRON],
};

const REBALANCE_CHAINS_BY_SYMBOL: Record<SupportedToken, readonly number[]> = {
  USDT: [
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.MONAD,
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
    CHAIN_IDs.BSC,
  ],
  WETH: [CHAIN_IDs.MAINNET],
};

const SAME_ASSET_BRIDGE_ADAPTER_BY_SYMBOL: Record<StableToken, "cctp" | "oft"> = {
  USDC: "cctp",
  USDT: "oft",
};

function configuredChainsForToken(rebalancerConfig: RebalancerConfig, token: SupportedToken): number[] {
  return REBALANCE_CHAINS_BY_SYMBOL[token].filter((chainId) => rebalancerConfig.chainIds.includes(chainId));
}

function canUseHyperliquidStablecoinRoute({
  sourceChain,
  destinationChain,
}: {
  sourceChain: number;
  destinationChain: number;
}): boolean {
  return (
    sourceChain !== CHAIN_IDs.BSC &&
    destinationChain !== CHAIN_IDs.BSC &&
    sourceChain !== CHAIN_IDs.TRON &&
    destinationChain !== CHAIN_IDs.TRON
  );
}

function canUseSameAssetBridgeRoute(token: StableToken, sourceChain: number, destinationChain: number): boolean {
  if (sourceChain === CHAIN_IDs.BSC || destinationChain === CHAIN_IDs.BSC) {
    return false;
  }
  return token !== "USDT" || (sourceChain !== CHAIN_IDs.TRON && destinationChain !== CHAIN_IDs.TRON);
}

function buildSameAssetRoutes(rebalancerConfig: RebalancerConfig, token: StableToken): RebalanceRoute[] {
  if (!rebalancerConfig.cumulativeTargetBalances[token]?.targetBalance) {
    return [];
  }
  const routes: RebalanceRoute[] = [];
  const configuredChains = configuredChainsForToken(rebalancerConfig, token);
  const directBinanceNetworks = new Set(BINANCE_NETWORKS_BY_SYMBOL[token]);

  for (const sourceChain of configuredChains) {
    for (const destinationChain of configuredChains) {
      if (sourceChain === destinationChain) {
        continue;
      }

      if (canUseSameAssetBridgeRoute(token, sourceChain, destinationChain)) {
        routes.push({
          sourceChain,
          sourceToken: token,
          destinationChain,
          destinationToken: token,
          adapter: SAME_ASSET_BRIDGE_ADAPTER_BY_SYMBOL[token],
        });
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

type DifferentAssetPairRule = {
  tokenA: SupportedToken;
  tokenB: SupportedToken;
  adapter: DifferentAssetAdapter;
  allow?: (params: { sourceChain: number; destinationChain: number }) => boolean;
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
      if (rule.allow && !rule.allow({ sourceChain, destinationChain })) {
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
