import { assert, CHAIN_IDs, EvmAddress, getTokenInfo, isDefined, Signer, winston } from "../utils";
import { CUSTOM_BRIDGE } from "../common";
import { BinanceStablecoinSwapBridge } from "../adapter/bridges";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { CctpAdapter } from "./adapters/cctpAdapter";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { OftAdapter } from "./adapters/oftAdapter";
import { BaseRebalancerClient } from "./clients/BaseRebalancerClient";
import { CumulativeBalanceRebalancerClient } from "./clients/CumulativeBalanceRebalancerClient";
import { ReadOnlyRebalancerClient } from "./clients/ReadOnlyRebalancerClient";

import { RebalancerConfig } from "./RebalancerConfig";
import { buildBridgeSupportRoutes, buildRebalanceRoutes } from "./buildRebalanceRoutes";
import { RebalancerAdapter, RebalanceRoute } from "./utils/interfaces";

export type AdapterName = "cctp" | "oft" | "hyperliquid" | "binance";
type AdapterMap = { [name: string]: RebalancerAdapter };
type RebalancerClientConstructor<T extends BaseRebalancerClient> = new (
  logger: winston.Logger,
  rebalancerConfig: RebalancerConfig,
  adapters: AdapterMap,
  baseSigner: Signer,
  isReadonly: boolean
) => T;

// Derive the L1 -> L2 same-asset routes owned by the AdapterManager's Binance swap bridge: a route requires both
// a CUSTOM_BRIDGE registration and operator enablement of the token + destination chain in the rebalancer config.
export function buildAdapterManagerBinanceRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  return Object.entries(CUSTOM_BRIDGE).flatMap(([chainId, bridges]) =>
    Object.entries(bridges)
      .filter(([, Bridge]) => Bridge === BinanceStablecoinSwapBridge)
      .flatMap(([l1Token]) => {
        const { symbol } = getTokenInfo(EvmAddress.from(l1Token), CHAIN_IDs.MAINNET);
        if (!isDefined(rebalancerConfig.sameAssetBalances[symbol]?.[Number(chainId)])) {
          return [];
        }
        return [
          {
            sourceChain: CHAIN_IDs.MAINNET,
            sourceToken: symbol,
            destinationChain: Number(chainId),
            destinationToken: symbol,
            adapter: "binance",
          },
        ];
      })
  );
}

export function constructRebalancerDependencies(
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
  isReadonly: boolean,
  logLabel: string,
  message: string
): Promise<T> {
  const { rebalancerConfig, adapters } = constructRebalancerDependencies(logger, baseSigner);
  const rebalanceRoutes = getRebalanceRoutes(rebalancerConfig);
  const bridgeSupportRoutes = buildBridgeSupportRoutes(rebalanceRoutes);
  const rebalancerClient = new Client(logger, rebalancerConfig, adapters, baseSigner, isReadonly);

  await Promise.all(
    ["cctp", "oft"].flatMap((adapterName) =>
      adapters[adapterName] ? [adapters[adapterName].initialize(bridgeSupportRoutes)] : []
    )
  );
  // Initialize the Binance adapter first (initialize() is idempotent, first call wins) so it carries lifecycle
  // routes beyond the client's own rebalance routes, e.g. orders initiated by the AdapterManager's Binance swap
  // bridge. Routes are operator-configured, so a validation failure crashes the run like any other route.
  await adapters.binance?.initialize([...rebalanceRoutes, ...buildAdapterManagerBinanceRoutes(rebalancerConfig)]);
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
    false,
    "constructCumulativeBalanceRebalancerClient",
    "CumulativeBalanceRebalancerClient initialized"
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
