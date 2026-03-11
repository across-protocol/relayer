import { CHAIN_IDs, Signer, winston } from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { CctpAdapter } from "./adapters/cctpAdapter";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
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
  const binanceAdapter = new BinanceStablecoinSwapAdapter(
    logger,
    rebalancerConfig,
    baseSigner,
    cctpAdapter,
    oftAdapter
  );
  const adapterMap = { hyperliquid: hyperliquidAdapter, binance: binanceAdapter, cctp: cctpAdapter, oft: oftAdapter };

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
      for (const adapter of ["binance", "hyperliquid"]) {
        // Handle exceptions:
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

  for (const usdtChain of usdtChains.filter((chain) => chain !== CHAIN_IDs.BSC)) {
    for (const otherUsdtChain of usdtChains.filter((chain) => chain !== CHAIN_IDs.BSC)) {
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
  await rebalancerClient.initialize([]);
  logger.debug({
    at: "RebalancerClientHelper.constructReadOnlyRebalancerClient",
    message: "ReadOnlyRebalancerClient initialized",
    rebalancerConfig,
    adapterNames: Object.keys(adapters),
  });
  return rebalancerClient;
}
