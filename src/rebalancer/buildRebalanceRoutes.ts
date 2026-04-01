import { CHAIN_IDs, TOKEN_SYMBOLS_MAP, compareAddressesSimple } from "../utils";
import { SwapRoute } from "../interfaces/InventoryManagement";
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

  for (const usdtChain of USDT_REBALANCE_CHAINS.filter((chain) => chain !== CHAIN_IDs.BSC)) {
    for (const otherUsdtChain of USDT_REBALANCE_CHAINS.filter((chain) => chain !== CHAIN_IDs.BSC)) {
      if (!rebalancerConfig.chainIds.includes(usdtChain) || !rebalancerConfig.chainIds.includes(otherUsdtChain)) {
        continue;
      }
      if (usdtChain === otherUsdtChain) {
        continue;
      }
      rebalanceRoutes.push({
        sourceChain: usdtChain,
        sourceToken: "USDT",
        destinationChain: otherUsdtChain,
        destinationToken: "USDT",
        adapter: "oft",
      });
    }
  }

  for (const usdcChain of USDC_REBALANCE_CHAINS.filter((chain) => chain !== CHAIN_IDs.BSC)) {
    for (const otherUsdcChain of USDC_REBALANCE_CHAINS.filter((chain) => chain !== CHAIN_IDs.BSC)) {
      if (!rebalancerConfig.chainIds.includes(usdcChain) || !rebalancerConfig.chainIds.includes(otherUsdcChain)) {
        continue;
      }
      if (usdcChain === otherUsdcChain) {
        continue;
      }
      rebalanceRoutes.push({
        sourceChain: usdcChain,
        sourceToken: "USDC",
        destinationChain: otherUsdcChain,
        destinationToken: "USDC",
        adapter: "cctp",
      });
    }
  }

  return rebalanceRoutes;
}

export function buildJussiRebalanceRoutes(
  rebalancerConfig: RebalancerConfig,
  allowedSwapRoutes: SwapRoute[] = []
): RebalanceRoute[] {
  const baseRoutes = buildRebalanceRoutes(rebalancerConfig);
  const usdtChains = new Set(USDT_REBALANCE_CHAINS);
  const usdcChains = new Set(USDC_REBALANCE_CHAINS);
  const extraStablecoinSwapRoutes: RebalanceRoute[] = [];

  for (const swapRoute of allowedSwapRoutes) {
    if (swapRoute.fromChain === "ALL" || swapRoute.toChain === "ALL") {
      continue;
    }

    const sourceToken = resolveStablecoinSymbol(swapRoute.fromToken, swapRoute.fromChain);
    const destinationToken = resolveStablecoinSymbol(swapRoute.toToken, swapRoute.toChain);
    if (sourceToken === undefined || destinationToken === undefined || sourceToken === destinationToken) {
      continue;
    }

    if (sourceToken === "USDT") {
      usdtChains.add(swapRoute.fromChain);
    } else {
      usdcChains.add(swapRoute.fromChain);
    }

    if (destinationToken === "USDT") {
      usdtChains.add(swapRoute.toChain);
    } else {
      usdcChains.add(swapRoute.toChain);
    }

    extraStablecoinSwapRoutes.push({
      sourceChain: swapRoute.fromChain,
      sourceToken,
      destinationChain: swapRoute.toChain,
      destinationToken,
      adapter: "binance",
    });

    if (swapRoute.fromChain !== CHAIN_IDs.BSC && swapRoute.toChain !== CHAIN_IDs.BSC) {
      extraStablecoinSwapRoutes.push({
        sourceChain: swapRoute.fromChain,
        sourceToken,
        destinationChain: swapRoute.toChain,
        destinationToken,
        adapter: "hyperliquid",
      });
    }
  }

  const supportingRoutes: RebalanceRoute[] = [];
  for (const sourceChain of Array.from(usdtChains).filter((chain) => chain !== CHAIN_IDs.BSC)) {
    for (const destinationChain of Array.from(usdtChains).filter((chain) => chain !== CHAIN_IDs.BSC)) {
      if (sourceChain === destinationChain) {
        continue;
      }
      supportingRoutes.push({
        sourceChain,
        sourceToken: "USDT",
        destinationChain,
        destinationToken: "USDT",
        adapter: "oft",
      });
    }
  }

  for (const sourceChain of Array.from(usdcChains).filter((chain) => chain !== CHAIN_IDs.BSC)) {
    for (const destinationChain of Array.from(usdcChains).filter((chain) => chain !== CHAIN_IDs.BSC)) {
      if (sourceChain === destinationChain) {
        continue;
      }
      supportingRoutes.push({
        sourceChain,
        sourceToken: "USDC",
        destinationChain,
        destinationToken: "USDC",
        adapter: "cctp",
      });
    }
  }

  return dedupeRoutes([...baseRoutes, ...extraStablecoinSwapRoutes, ...supportingRoutes]);
}

function resolveStablecoinSymbol(tokenAddress: string, chainId: number): "USDC" | "USDT" | undefined {
  if (compareAddressesSimple(tokenAddress, TOKEN_SYMBOLS_MAP.USDC.addresses[chainId])) {
    return "USDC";
  }
  if (compareAddressesSimple(tokenAddress, TOKEN_SYMBOLS_MAP.USDT.addresses[chainId])) {
    return "USDT";
  }
  return undefined;
}

function dedupeRoutes(routes: RebalanceRoute[]): RebalanceRoute[] {
  const uniqueRoutes = new Map<string, RebalanceRoute>();
  for (const route of routes) {
    uniqueRoutes.set(
      [route.sourceChain, route.sourceToken, route.destinationChain, route.destinationToken, route.adapter].join("|"),
      route
    );
  }
  return Array.from(uniqueRoutes.values());
}

export { USDC_REBALANCE_CHAINS, USDT_REBALANCE_CHAINS };
