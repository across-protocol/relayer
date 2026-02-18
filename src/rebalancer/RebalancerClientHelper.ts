import { CHAIN_IDs, Signer, winston } from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { CctpAdapter } from "./adapters/cctpAdapter";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { OftAdapter } from "./adapters/oftAdapter";
import { RebalancerClient, RebalanceRoute } from "./rebalancer";
import { RebalancerConfig } from "./RebalancerConfig";

export async function constructRebalancerClient(logger: winston.Logger, baseSigner: Signer): Promise<RebalancerClient> {
  const rebalancerConfig = new RebalancerConfig(process.env);

  // Construct adapters:
  const hyperliquidAdapter = new HyperliquidStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);
  const binanceAdapter = new BinanceStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);
  const cctpAdapter = new CctpAdapter(logger, rebalancerConfig, baseSigner);
  const oftAdapter = new OftAdapter(logger, rebalancerConfig, baseSigner);

  const adapters = { oft: oftAdapter, cctp: cctpAdapter, hyperliquid: hyperliquidAdapter, binance: binanceAdapter };

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

  const rebalancerClient = new RebalancerClient(logger, rebalancerConfig, adapters, rebalanceRoutes, baseSigner);
  await rebalancerClient.initialize();
  return rebalancerClient;
}
