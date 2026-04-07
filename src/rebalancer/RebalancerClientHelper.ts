import { CHAIN_IDs, Signer, winston } from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { CctpAdapter } from "./adapters/cctpAdapter";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { MatchaSwapAdapter } from "./adapters/matchaAdapter";
import { OftAdapter } from "./adapters/oftAdapter";
import { CumulativeBalanceRebalancerClient } from "./clients/CumulativeBalanceRebalancerClient";
import { ReadOnlyRebalancerClient } from "./clients/ReadOnlyRebalancerClient";

import { RebalancerConfig } from "./RebalancerConfig";
import { RebalancerAdapter, RebalanceRoute } from "./utils/interfaces";

function constructRebalancerDependencies(
  logger: winston.Logger,
  baseSigner: Signer
): {
  rebalancerConfig: RebalancerConfig;
  adapters: { [name: string]: RebalancerAdapter };
  rebalanceRoutes: RebalanceRoute[];
} {
  const rebalancerConfig = new RebalancerConfig(process.env);

  // Construct adapters:
  const cctpAdapter = new CctpAdapter(logger, rebalancerConfig, baseSigner);
  const oftAdapter = new OftAdapter(logger, rebalancerConfig, baseSigner);
  const hyperliquidAdapter = new HyperliquidStablecoinSwapAdapter(
    logger,
    rebalancerConfig,
    baseSigner,
    cctpAdapter,
    oftAdapter
  );
  const adapterMap: { [name: string]: RebalancerAdapter } = {
    hyperliquid: hyperliquidAdapter,
    cctp: cctpAdapter,
    oft: oftAdapter,
  };
  if (process.env.BINANCE_API_KEY) {
    adapterMap.binance = new BinanceStablecoinSwapAdapter(
      logger,
      rebalancerConfig,
      baseSigner,
      cctpAdapter,
      oftAdapter
    );
  }
  if (process.env.ZERO_X_API_KEY) {
    adapterMap.matcha = new MatchaSwapAdapter(logger, rebalancerConfig, baseSigner, cctpAdapter, oftAdapter);
  }

  // Following two variables are hardcoded to aid testing:
  const usdtChains = [
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.BSC,
  ];
  const usdcChains = [
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.BASE,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.BSC,
  ];
  const rebalanceRoutes: RebalanceRoute[] = [];
  for (const usdtChain of usdtChains) {
    for (const usdcChain of usdcChains) {
      if (!rebalancerConfig.chainIds.includes(usdtChain) || !rebalancerConfig.chainIds.includes(usdcChain)) {
        continue;
      }
      const swapAdapters = ["hyperliquid", "binance", "matcha"].filter((name) => adapterMap[name]);
      for (const adapter of swapAdapters) {
        // Handle exceptions: Only Hyperliquid cannot handle BSC routes.
        if (adapter === "hyperliquid" && (usdtChain === CHAIN_IDs.BSC || usdcChain === CHAIN_IDs.BSC)) {
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

  for (const usdtChain of usdtChains.filter((chain) => chain !== CHAIN_IDs.BSC)) {
    for (const otherUsdtChain of usdtChains.filter((chain) => chain !== CHAIN_IDs.BSC)) {
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
  for (const usdcChain of usdcChains.filter((chain) => chain !== CHAIN_IDs.BSC)) {
    for (const otherUsdcChain of usdcChains.filter((chain) => chain !== CHAIN_IDs.BSC)) {
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

  // @todo: Add test-net support for this client. For now, we only support production and we do not construct
  // any adapters or routes when running on test net.
  const adaptersToUpdate: Record<string, RebalancerAdapter> =
    rebalancerConfig.hubPoolChainId === CHAIN_IDs.MAINNET ? adapterMap : {};

  return { rebalancerConfig, adapters: adaptersToUpdate, rebalanceRoutes };
}

export async function constructCumulativeBalanceRebalancerClient(
  logger: winston.Logger,
  baseSigner: Signer
): Promise<CumulativeBalanceRebalancerClient> {
  const { rebalancerConfig, adapters, rebalanceRoutes } = constructRebalancerDependencies(logger, baseSigner);
  const isReadonly = false;
  const rebalancerClient = new CumulativeBalanceRebalancerClient(
    logger,
    rebalancerConfig,
    adapters,
    baseSigner,
    isReadonly
  );
  // Initialize the CCTP and OFT Adapters first before initializing the Binance and HL adapters which use the former
  // adapters. Only initialize them if they are present in the adapters map.
  const adapterInitPromises: Promise<void>[] = [];
  if (adapters["cctp"]) {
    adapterInitPromises.push(adapters["cctp"].initialize(rebalanceRoutes));
  }
  if (adapters["oft"]) {
    adapterInitPromises.push(adapters["oft"].initialize(rebalanceRoutes));
  }
  await Promise.all(adapterInitPromises);
  await rebalancerClient.initialize(rebalanceRoutes);
  logger.debug({
    at: "RebalancerClientHelper.constructCumulativeBalanceRebalancerClient",
    message: "CumulativeBalanceRebalancerClient initialized",
    rebalancerConfig,
    adapterNames: Object.keys(adapters),
  });
  return rebalancerClient;
}

export async function constructReadOnlyRebalancerClient(
  logger: winston.Logger,
  baseSigner: Signer
): Promise<ReadOnlyRebalancerClient> {
  const { rebalancerConfig, adapters } = constructRebalancerDependencies(logger, baseSigner);
  const isReadonly = true;
  const rebalancerClient = new ReadOnlyRebalancerClient(logger, rebalancerConfig, adapters, baseSigner, isReadonly);
  // Initialize the CCTP and OFT Adapters first before initializing the Binance and HL adapters which use the former
  // adapters. Only initialize them if they are present in the adapters map.
  const adapterInitPromises: Promise<void>[] = [];
  if (adapters["cctp"]) {
    adapterInitPromises.push(adapters["cctp"].initialize([]));
  }
  if (adapters["oft"]) {
    adapterInitPromises.push(adapters["oft"].initialize([]));
  }
  await Promise.all(adapterInitPromises);
  await rebalancerClient.initialize([]);
  logger.debug({
    at: "RebalancerClientHelper.constructReadOnlyRebalancerClient",
    message: "ReadOnlyRebalancerClient initialized",
    rebalancerConfig,
    adapterNames: Object.keys(adapters),
  });
  return rebalancerClient;
}
