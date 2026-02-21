import { CHAIN_IDs, getNetworkName, Signer, winston } from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { CctpAdapter } from "./adapters/cctpAdapter";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { OftAdapter } from "./adapters/oftAdapter";
import { RebalancerAdapter, RebalancerClient, RebalanceRoute } from "./rebalancer";
import { RebalancerConfig } from "./RebalancerConfig";

export async function constructRebalancerClient(logger: winston.Logger, baseSigner: Signer): Promise<RebalancerClient> {
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

  // Pass in adapters that are used in at least one rebalance route:
  const adapterNames = new Set<string>(rebalanceRoutes.map((route) => route.adapter));
  const adapters: { [name: string]: RebalancerAdapter } = {};
  for (const adapterName of adapterNames) {
    adapters[adapterName] = adapterMap[adapterName];
  }
  const rebalancerClient = new RebalancerClient(logger, rebalancerConfig, adapters, rebalanceRoutes, baseSigner);
  await rebalancerClient.initialize();
  logger.debug({
    at: "RebalancerClientHelper.constructRebalancerClient",
    message: "RebalancerClient initialized",
    rebalancerConfig,
    rebalanceRoutes: rebalanceRoutes.map((route) => ({
      sourceChain: getNetworkName(route.sourceChain),
      sourceToken: route.sourceToken,
      destinationChain: getNetworkName(route.destinationChain),
      destinationToken: route.destinationToken,
      adapter: route.adapter,
    })),
  });
  return rebalancerClient;
}
