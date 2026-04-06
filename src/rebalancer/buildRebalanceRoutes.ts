import { CHAIN_IDs } from "../utils";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalanceRoute } from "./utils/interfaces";

type SupportedToken = "USDC" | "USDT" | "WETH";
type StableToken = Exclude<SupportedToken, "WETH">;

// Direct Binance deposit/withdraw networks for each token. This is intentionally separate from the rebalancer route
// set so we can track venue support without automatically enabling every listed network operationally.
const BINANCE_NETWORKS_BY_SYMBOL: Record<SupportedToken, readonly number[]> = {
  USDC: [CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BASE, CHAIN_IDs.BSC],
  USDT: [CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BSC],
  // Live Binance ETH networkList currently includes ARBITRUM, BASE, BSC, ETH, OPTIMISM, SCROLL, and ZKSYNCERA.
  // The rebalancer support list below stays narrower until we intentionally enable more of those networks.
  WETH: [CHAIN_IDs.ARBITRUM, CHAIN_IDs.BASE, CHAIN_IDs.BSC, CHAIN_IDs.MAINNET, CHAIN_IDs.OPTIMISM, CHAIN_IDs.SCROLL, CHAIN_IDs.ZK_SYNC],
};

const REBALANCE_CHAINS_BY_SYMBOL: Record<SupportedToken, readonly number[]> = {
  USDT: [CHAIN_IDs.HYPEREVM, CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.UNICHAIN, CHAIN_IDs.MONAD, CHAIN_IDs.BSC],
  USDC: [CHAIN_IDs.HYPEREVM, CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BASE, CHAIN_IDs.UNICHAIN, CHAIN_IDs.MONAD, CHAIN_IDs.BSC],
  WETH: [CHAIN_IDs.ARBITRUM, CHAIN_IDs.BASE, CHAIN_IDs.BSC, CHAIN_IDs.MAINNET, CHAIN_IDs.OPTIMISM],
};

const SAME_ASSET_BRIDGE_ADAPTER_BY_SYMBOL: Record<StableToken, "cctp" | "oft"> = {
  USDC: "cctp",
  USDT: "oft",
};

function configuredChainsForToken(rebalancerConfig: RebalancerConfig, token: SupportedToken): number[] {
  return REBALANCE_CHAINS_BY_SYMBOL[token].filter((chainId) => rebalancerConfig.chainIds.includes(chainId));
}

function buildSameAssetRoutes(rebalancerConfig: RebalancerConfig, token: SupportedToken): RebalanceRoute[] {
  const routes: RebalanceRoute[] = [];
  const configuredChains = configuredChainsForToken(rebalancerConfig, token);
  const directBinanceNetworks = new Set(BINANCE_NETWORKS_BY_SYMBOL[token]);

  for (const sourceChain of configuredChains) {
    for (const destinationChain of configuredChains) {
      if (sourceChain === destinationChain) {
        continue;
      }

      if (token !== "WETH" && sourceChain !== CHAIN_IDs.BSC && destinationChain !== CHAIN_IDs.BSC) {
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

export function buildRebalanceRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  const rebalanceRoutes: RebalanceRoute[] = [];
  const usdtChains = configuredChainsForToken(rebalancerConfig, "USDT");
  const usdcChains = configuredChainsForToken(rebalancerConfig, "USDC");
  const wethChains = configuredChainsForToken(rebalancerConfig, "WETH");
  const directBinanceWethChains = wethChains.filter((chainId) => BINANCE_NETWORKS_BY_SYMBOL.WETH.includes(chainId));

  for (const usdtChain of usdtChains) {
    for (const usdcChain of usdcChains) {
      for (const adapter of ["binance", "hyperliquid"]) {
        if (adapter !== "binance" && (usdtChain === CHAIN_IDs.BSC || usdcChain === CHAIN_IDs.BSC)) {
          continue;
        }

        rebalanceRoutes.push({
          sourceChain: usdtChain,
          sourceToken: "USDT",
          destinationChain: usdcChain,
          destinationToken: "USDC",
          adapter,
        });
        rebalanceRoutes.push({
          sourceChain: usdcChain,
          sourceToken: "USDC",
          destinationChain: usdtChain,
          destinationToken: "USDT",
          adapter,
        });
      }
    }
  }

  rebalanceRoutes.push(...buildSameAssetRoutes(rebalancerConfig, "USDT"));
  rebalanceRoutes.push(...buildSameAssetRoutes(rebalancerConfig, "USDC"));

  // WETH<->stablecoin swap routes via Binance only. WETH chains are restricted to direct Binance deposit/withdrawal
  // networks for ETH.
  for (const wethChain of directBinanceWethChains) {
    for (const usdtChain of usdtChains) {
      rebalanceRoutes.push({
        sourceChain: wethChain,
        sourceToken: "WETH",
        destinationChain: usdtChain,
        destinationToken: "USDT",
        adapter: "binance",
      });
      rebalanceRoutes.push({
        sourceChain: usdtChain,
        sourceToken: "USDT",
        destinationChain: wethChain,
        destinationToken: "WETH",
        adapter: "binance",
      });
    }
    for (const usdcChain of usdcChains) {
      rebalanceRoutes.push({
        sourceChain: wethChain,
        sourceToken: "WETH",
        destinationChain: usdcChain,
        destinationToken: "USDC",
        adapter: "binance",
      });
      rebalanceRoutes.push({
        sourceChain: usdcChain,
        sourceToken: "USDC",
        destinationChain: wethChain,
        destinationToken: "WETH",
        adapter: "binance",
      });
    }
  }

  rebalanceRoutes.push(...buildSameAssetRoutes(rebalancerConfig, "WETH"));

  return rebalanceRoutes;
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
