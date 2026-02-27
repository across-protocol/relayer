import { CHAIN_IDs, Signer, winston } from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { CctpAdapter } from "./adapters/cctpAdapter";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { OftAdapter } from "./adapters/oftAdapter";
import { CumulativeBalanceRebalancerClient } from "./clients/CumulativeBalanceRebalancerClient";
import { ReadOnlyRebalancerClient } from "./clients/ReadOnlyRebalancerClient";
import { SingleBalanceRebalancerClient } from "./clients/SingleBalanceRebalancerClient";

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
  const hyperliquidAdapter = new HyperliquidStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);
  const binanceAdapter = new BinanceStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);
  const cctpAdapter = new CctpAdapter(logger, rebalancerConfig, baseSigner);
  const oftAdapter = new OftAdapter(logger, rebalancerConfig, baseSigner);
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

  return { rebalancerConfig, adapters: adapterMap, rebalanceRoutes };
}

export async function constructCumulativeBalanceRebalancerClient(
  logger: winston.Logger,
  baseSigner: Signer
): Promise<CumulativeBalanceRebalancerClient> {
  const { rebalancerConfig, adapters, rebalanceRoutes } = constructRebalancerDependencies(logger, baseSigner);
  const rebalancerClient = new CumulativeBalanceRebalancerClient(logger, rebalancerConfig, adapters, baseSigner);
  await rebalancerClient.initialize(rebalanceRoutes);
  logger.debug({
    at: "RebalancerClientHelper.constructCumulativeBalanceRebalancerClient",
    message: "CumulativeBalanceRebalancerClient initialized",
    rebalancerConfig,
    adapterNames: Object.keys(adapters),
  });
  return rebalancerClient;
}

export async function constructSingleBalanceRebalancerClient(
  logger: winston.Logger,
  baseSigner: Signer
): Promise<SingleBalanceRebalancerClient> {
  const { rebalancerConfig, adapters, rebalanceRoutes } = constructRebalancerDependencies(logger, baseSigner);
  const rebalancerClient = new SingleBalanceRebalancerClient(logger, rebalancerConfig, adapters, baseSigner);
  await rebalancerClient.initialize(rebalanceRoutes);
  logger.debug({
    at: "RebalancerClientHelper.constructSingleBalanceRebalancerClient",
    message: "SingleBalanceRebalancerClient initialized",
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
  const rebalancerClient = new ReadOnlyRebalancerClient(logger, rebalancerConfig, adapters, baseSigner);
  await rebalancerClient.initialize([]);
  logger.debug({
    at: "RebalancerClientHelper.constructReadOnlyRebalancerClient",
    message: "ReadOnlyRebalancerClient initialized",
    rebalancerConfig,
    adapterNames: Object.keys(adapters),
  });
  return rebalancerClient;
}
