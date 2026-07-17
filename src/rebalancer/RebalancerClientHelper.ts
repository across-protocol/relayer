import { assert, CHAIN_IDs, Signer, winston } from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { CctpAdapter } from "./adapters/cctpAdapter";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { OftAdapter } from "./adapters/oftAdapter";
import { BaseRebalancerClient } from "./clients/BaseRebalancerClient";
import { CumulativeBalanceRebalancerClient } from "./clients/CumulativeBalanceRebalancerClient";
import { ReadOnlyRebalancerClient } from "./clients/ReadOnlyRebalancerClient";

import { RebalancerConfig } from "./RebalancerConfig";
import { buildRebalanceRoutes } from "./buildRebalanceRoutes";
import { RebalancerAdapter, RebalanceRoute } from "./utils/interfaces";
import { SameAssetRebalancerClient } from "./clients/SameAssetRebalancerClient";
import { buildSameAssetRebalanceRoutes } from "./buildSameAssetRebalanceRoutes";

export type AdapterName = "cctp" | "oft" | "hyperliquid" | "binance";
type AdapterMap = { [name: string]: RebalancerAdapter };

// The swapRebalancer and sameAssetRebalancer bots share the same base signer and Redis-backed order state, so each
// bot's updateRebalanceStatuses() can pick up and progress pending orders created by the other. The CCTP/OFT bridge
// adapters execute the intermediate and final bridge legs of those orders (e.g. a Hyperliquid order's final CCTP leg
// from HyperEVM to its destination chain), so they must be initialized with the union of every mode's route catalog
// rather than only the current mode's. Otherwise, progressing another mode's order throws
// "Route is not supported: <token> <sourceChain> -> <token> <destinationChain>" and crashes the whole run.
export function buildAllExecutableRebalanceRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  return [...buildRebalanceRoutes(rebalancerConfig), ...buildSameAssetRebalanceRoutes(rebalancerConfig)];
}
type RebalancerClientConstructor<T extends BaseRebalancerClient> = new (
  logger: winston.Logger,
  rebalancerConfig: RebalancerConfig,
  adapters: AdapterMap,
  baseSigner: Signer,
  isReadonly: boolean
) => T;

function constructRebalancerDependencies(
  logger: winston.Logger,
  baseSigner: Signer
): {
  rebalancerConfig: RebalancerConfig;
  adapters: AdapterMap;
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

  // @todo: Add test-net support for this client. For now, we only support production and we do not construct
  // any adapters or routes when running on test net.
  const adaptersToUpdate: AdapterMap = rebalancerConfig.hubPoolChainId === CHAIN_IDs.MAINNET ? adapterMap : {};

  return { rebalancerConfig, adapters: adaptersToUpdate };
}

async function constructInitializedRebalancerClient<T extends BaseRebalancerClient>(
  logger: winston.Logger,
  baseSigner: Signer,
  Client: RebalancerClientConstructor<T>,
  getRebalanceRoutes: (rebalancerConfig: RebalancerConfig) => RebalanceRoute[],
  getBridgeAdapterRoutes: (rebalancerConfig: RebalancerConfig) => RebalanceRoute[],
  isReadonly: boolean,
  logLabel: string,
  message: string
): Promise<T> {
  const { rebalancerConfig, adapters } = constructRebalancerDependencies(logger, baseSigner);
  const rebalanceRoutes = getRebalanceRoutes(rebalancerConfig);
  const rebalancerClient = new Client(logger, rebalancerConfig, adapters, baseSigner, isReadonly);

  // Initialize the CCTP/OFT bridge adapters first (adapter.initialize() is idempotent, so the subsequent
  // rebalancerClient.initialize() call is a no-op for them) with the bridge-adapter route catalog, which may be a
  // superset of this mode's rebalanceRoutes. See buildAllExecutableRebalanceRoutes for why.
  const bridgeAdapterRoutes = getBridgeAdapterRoutes(rebalancerConfig);
  await Promise.all(
    ["cctp", "oft"].flatMap((adapterName) =>
      adapters[adapterName] ? [adapters[adapterName].initialize(bridgeAdapterRoutes)] : []
    )
  );
  await rebalancerClient.initialize(rebalanceRoutes);
  logger.debug({
    at: `RebalancerClientHelper.${logLabel}`,
    message,
    rebalancerConfig,
    adapterNames: Object.keys(adapters),
  });
  return rebalancerClient;
}

export async function constructCumulativeBalanceRebalancerClient(
  logger: winston.Logger,
  baseSigner: Signer,
  rebalanceRoutesOverride?: RebalanceRoute[]
): Promise<CumulativeBalanceRebalancerClient> {
  return constructInitializedRebalancerClient(
    logger,
    baseSigner,
    CumulativeBalanceRebalancerClient,
    (rebalancerConfig) => rebalanceRoutesOverride ?? buildRebalanceRoutes(rebalancerConfig),
    (rebalancerConfig) => rebalanceRoutesOverride ?? buildAllExecutableRebalanceRoutes(rebalancerConfig),
    false,
    "constructCumulativeBalanceRebalancerClient",
    "CumulativeBalanceRebalancerClient initialized"
  );
}

export async function constructSameAssetRebalancerClient(
  logger: winston.Logger,
  baseSigner: Signer,
  rebalanceRoutesOverride?: RebalanceRoute[]
): Promise<SameAssetRebalancerClient> {
  return constructInitializedRebalancerClient(
    logger,
    baseSigner,
    SameAssetRebalancerClient,
    (rebalancerConfig) => rebalanceRoutesOverride ?? buildSameAssetRebalanceRoutes(rebalancerConfig),
    (rebalancerConfig) => rebalanceRoutesOverride ?? buildAllExecutableRebalanceRoutes(rebalancerConfig),
    false,
    "constructSameAssetRebalancerClient",
    "SameAssetRebalancerClient initialized"
  );
}

export async function constructReadOnlyRebalancerClient(
  logger: winston.Logger,
  baseSigner: Signer
): Promise<ReadOnlyRebalancerClient> {
  return constructInitializedRebalancerClient(
    logger,
    baseSigner,
    ReadOnlyRebalancerClient,
    () => [],
    // The read-only client never initiates or progresses orders, so its adapters don't need any routes. Keeping the
    // catalog empty also avoids running route validation in relayer/monitor contexts that don't configure routes.
    () => [],
    true,
    "constructReadOnlyRebalancerClient",
    "ReadOnlyRebalancerClient initialized"
  );
}

export async function constructAdapter(
  logger: winston.Logger,
  baseSigner: Signer,
  adapterName: AdapterName
): Promise<RebalancerAdapter> {
  const { adapters } = constructRebalancerDependencies(logger, baseSigner);
  const adapter = adapters[adapterName];
  assert(adapter, `Adapter ${adapterName} is unavailable for the configured hub chain`);
  await adapter.initialize([]);
  return adapter;
}
