import { CHAIN_IDs } from "../utils";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalanceRoute } from "./utils/interfaces";

type SupportedToken = "USDC" | "USDT" | "WETH";
type StableToken = Exclude<SupportedToken, "WETH">;
type DifferentAssetAdapter = "binance" | "hyperliquid";
type ChainSelector = (rebalancerConfig: RebalancerConfig) => number[];

// Direct Binance deposit/withdraw networks for each token. This is intentionally separate from the rebalancer route
// set so we can track venue support without automatically enabling every listed network operationally.
const BINANCE_NETWORKS_BY_SYMBOL: Record<SupportedToken, readonly number[]> = {
  USDC: [CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BASE, CHAIN_IDs.BSC],
  USDT: [CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BSC],
  // Live Binance ETH networkList currently includes ARBITRUM, BASE, BSC, ETH, OPTIMISM, SCROLL, and ZKSYNCERA.
  // The rebalancer support list below stays narrower until we intentionally enable more of those networks. We filter
  // this further by limiting to chains where we have an Atomic Depositor contract.
  WETH: [CHAIN_IDs.MAINNET],
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

function hasSameAssetBridgeAdapter(token: SupportedToken): token is StableToken {
  return token in SAME_ASSET_BRIDGE_ADAPTER_BY_SYMBOL;
}

function configuredChainsForToken(rebalancerConfig: RebalancerConfig, token: SupportedToken): number[] {
  return REBALANCE_CHAINS_BY_SYMBOL[token].filter((chainId) => rebalancerConfig.chainIds.includes(chainId));
}

function configuredDirectBinanceChainsForToken(rebalancerConfig: RebalancerConfig, token: SupportedToken): number[] {
  return configuredChainsForToken(rebalancerConfig, token).filter((chainId) =>
    BINANCE_NETWORKS_BY_SYMBOL[token].includes(chainId)
  );
}

function configuredChains(token: SupportedToken): ChainSelector {
  return (rebalancerConfig) => configuredChainsForToken(rebalancerConfig, token);
}

function configuredDirectBinanceChains(token: SupportedToken): ChainSelector {
  return (rebalancerConfig) => configuredDirectBinanceChainsForToken(rebalancerConfig, token);
}

function canUseHyperliquidStablecoinRoute({
  sourceChain,
  destinationChain,
}: {
  sourceChain: number;
  destinationChain: number;
}): boolean {
  return sourceChain !== CHAIN_IDs.BSC && destinationChain !== CHAIN_IDs.BSC;
}

function buildSameAssetRoutes(rebalancerConfig: RebalancerConfig, token: SupportedToken): RebalanceRoute[] {
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

      if (hasSameAssetBridgeAdapter(token) && sourceChain !== CHAIN_IDs.BSC && destinationChain !== CHAIN_IDs.BSC) {
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
  chainsA: ChainSelector;
  chainsB: ChainSelector;
  allow?: (params: { sourceChain: number; destinationChain: number }) => boolean;
};

const DIFFERENT_ASSET_ROUTE_RULES: readonly DifferentAssetPairRule[] = [
  {
    tokenA: "USDT",
    tokenB: "USDC",
    adapter: "binance",
    chainsA: configuredChains("USDT"),
    chainsB: configuredChains("USDC"),
  },
  {
    tokenA: "USDT",
    tokenB: "USDC",
    adapter: "hyperliquid",
    chainsA: configuredChains("USDT"),
    chainsB: configuredChains("USDC"),
    allow: canUseHyperliquidStablecoinRoute,
  },
  {
    tokenA: "WETH",
    tokenB: "USDT",
    adapter: "binance",
    chainsA: configuredDirectBinanceChains("WETH"),
    chainsB: configuredChains("USDT"),
  },
  {
    tokenA: "WETH",
    tokenB: "USDC",
    adapter: "binance",
    chainsA: configuredDirectBinanceChains("WETH"),
    chainsB: configuredChains("USDC"),
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
    const chainsA = rule.chainsA(rebalancerConfig);
    const chainsB = rule.chainsB(rebalancerConfig);

    if (
      !rebalancerConfig.cumulativeTargetBalances[rule.tokenA]?.targetBalance ||
      !rebalancerConfig.cumulativeTargetBalances[rule.tokenB]?.targetBalance
    ) {
      continue;
    }
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
    ...buildSameAssetRoutes(rebalancerConfig, "WETH"),
  ];
}

export function dedupeRebalanceRoutes(routes: RebalanceRoute[]): RebalanceRoute[] {
  const uniqueRoutes = new Map<string, RebalanceRoute>();
  for (const route of routes) {
    uniqueRoutes.set(
      [route.sourceChain, route.sourceToken, route.destinationChain, route.destinationToken, route.adapter].join("|"),
      route
    );
  }
  return Array.from(uniqueRoutes.values());
}

export { BINANCE_NETWORKS_BY_SYMBOL, REBALANCE_CHAINS_BY_SYMBOL };
