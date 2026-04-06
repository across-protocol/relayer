import { CHAIN_IDs } from "../utils";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalanceRoute } from "./utils/interfaces";

const USDT_REBALANCE_CHAINS = [
  CHAIN_IDs.HYPEREVM,
  CHAIN_IDs.ARBITRUM,
  CHAIN_IDs.OPTIMISM,
  CHAIN_IDs.MAINNET,
  CHAIN_IDs.UNICHAIN,
  CHAIN_IDs.MONAD,
  CHAIN_IDs.BSC,
];

const USDC_REBALANCE_CHAINS = [
  CHAIN_IDs.HYPEREVM,
  CHAIN_IDs.ARBITRUM,
  CHAIN_IDs.OPTIMISM,
  CHAIN_IDs.MAINNET,
  CHAIN_IDs.BASE,
  CHAIN_IDs.UNICHAIN,
  CHAIN_IDs.MONAD,
  CHAIN_IDs.BSC,
];

const WETH_REBALANCE_CHAINS = [
  CHAIN_IDs.ARBITRUM,
  CHAIN_IDs.BASE,
  CHAIN_IDs.BSC,
  CHAIN_IDs.MAINNET,
  CHAIN_IDs.OPTIMISM,
];

const DIRECT_BINANCE_USDT_CHAINS = [CHAIN_IDs.ARBITRUM, CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, CHAIN_IDs.BSC];
const DIRECT_BINANCE_USDC_CHAINS = [
  CHAIN_IDs.ARBITRUM,
  CHAIN_IDs.OPTIMISM,
  CHAIN_IDs.MAINNET,
  CHAIN_IDs.BASE,
  CHAIN_IDs.BSC,
];

export function buildRebalanceRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  const rebalanceRoutes: RebalanceRoute[] = [];

  for (const usdtChain of USDT_REBALANCE_CHAINS) {
    for (const usdcChain of USDC_REBALANCE_CHAINS) {
      if (!rebalancerConfig.chainIds.includes(usdtChain) || !rebalancerConfig.chainIds.includes(usdcChain)) {
        continue;
      }
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

  for (const usdtChain of USDT_REBALANCE_CHAINS) {
    for (const otherUsdtChain of USDT_REBALANCE_CHAINS) {
      if (!rebalancerConfig.chainIds.includes(usdtChain) || !rebalancerConfig.chainIds.includes(otherUsdtChain)) {
        continue;
      }
      if (usdtChain === otherUsdtChain) {
        continue;
      }
      if (otherUsdtChain !== CHAIN_IDs.BSC) {
        rebalanceRoutes.push({
          sourceChain: usdtChain,
          sourceToken: "USDT",
          destinationChain: otherUsdtChain,
          destinationToken: "USDT",
          adapter: "oft",
        });
      }
      if (
        DIRECT_BINANCE_USDT_CHAINS.includes(usdtChain) &&
        DIRECT_BINANCE_USDT_CHAINS.includes(otherUsdtChain)
      ) {
        rebalanceRoutes.push({
          sourceChain: usdtChain,
          sourceToken: "USDT",
          destinationChain: otherUsdtChain,
          destinationToken: "USDT",
          adapter: "binance",
        });
      }
    }
  }

  for (const usdcChain of USDC_REBALANCE_CHAINS) {
    for (const otherUsdcChain of USDC_REBALANCE_CHAINS) {
      if (!rebalancerConfig.chainIds.includes(usdcChain) || !rebalancerConfig.chainIds.includes(otherUsdcChain)) {
        continue;
      }
      if (usdcChain === otherUsdcChain) {
        continue;
      }
      if (otherUsdcChain !== CHAIN_IDs.BSC) {
        rebalanceRoutes.push({
          sourceChain: usdcChain,
          sourceToken: "USDC",
          destinationChain: otherUsdcChain,
          destinationToken: "USDC",
          adapter: "cctp",
        });
      }
      if (
        DIRECT_BINANCE_USDC_CHAINS.includes(usdcChain) &&
        DIRECT_BINANCE_USDC_CHAINS.includes(otherUsdcChain)
      ) {
        rebalanceRoutes.push({
          sourceChain: usdcChain,
          sourceToken: "USDC",
          destinationChain: otherUsdcChain,
          destinationToken: "USDC",
          adapter: "binance",
        });
      }
    }
  }

  // WETH<->stablecoin swap routes via Binance only. WETH chains are restricted to direct Binance deposit/withdrawal
  // networks for ETH.
  for (const wethChain of WETH_REBALANCE_CHAINS) {
    if (!rebalancerConfig.chainIds.includes(wethChain)) {
      continue;
    }
    for (const usdtChain of USDT_REBALANCE_CHAINS) {
      if (!rebalancerConfig.chainIds.includes(usdtChain)) {
        continue;
      }
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
    for (const usdcChain of USDC_REBALANCE_CHAINS) {
      if (!rebalancerConfig.chainIds.includes(usdcChain)) {
        continue;
      }
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

  for (const sourceWethChain of WETH_REBALANCE_CHAINS) {
    if (!rebalancerConfig.chainIds.includes(sourceWethChain)) {
      continue;
    }
    for (const destinationWethChain of WETH_REBALANCE_CHAINS) {
      if (!rebalancerConfig.chainIds.includes(destinationWethChain) || sourceWethChain === destinationWethChain) {
        continue;
      }
      rebalanceRoutes.push({
        sourceChain: sourceWethChain,
        sourceToken: "WETH",
        destinationChain: destinationWethChain,
        destinationToken: "WETH",
        adapter: "binance",
      });
    }
  }

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

export { DIRECT_BINANCE_USDC_CHAINS, DIRECT_BINANCE_USDT_CHAINS, USDC_REBALANCE_CHAINS, USDT_REBALANCE_CHAINS };
