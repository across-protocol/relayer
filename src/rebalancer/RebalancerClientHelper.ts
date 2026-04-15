import { CHAIN_IDs, Signer, winston } from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { CctpAdapter } from "./adapters/cctpAdapter";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { OftAdapter } from "./adapters/oftAdapter";
import { CumulativeBalanceRebalancerClient } from "./clients/CumulativeBalanceRebalancerClient";
import { ReadOnlyRebalancerClient } from "./clients/ReadOnlyRebalancerClient";

import { RebalancerConfig } from "./RebalancerConfig";
import { buildRebalanceRoutes } from "./buildRebalanceRoutes";
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
  const rebalanceRoutes: RebalanceRoute[] = buildRebalanceRoutes(rebalancerConfig);

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
