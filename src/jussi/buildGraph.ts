import {
  CANONICAL_BRIDGE,
  CANONICAL_L2_BRIDGE,
  CCTP_MAX_SEND_AMOUNT,
  CUSTOM_BRIDGE,
  CUSTOM_L2_BRIDGE,
  IOFT_ABI_FULL,
  LZ_FEE_TOKENS,
  TOKEN_SPLITTER_BRIDGES,
} from "../common";
import { EXPECTED_L1_TO_L2_MESSAGE_TIME, SLOW_WITHDRAWAL_CHAINS } from "../common/Constants";
import { InventoryClient } from "../clients";
import { InventoryConfig, TokenBalanceConfig, isAliasConfig } from "../interfaces/InventoryManagement";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { BinanceStablecoinSwapAdapter, isSameBinanceCoinRoute } from "../rebalancer/adapters/binance";
import { RebalanceRoute, RebalancerAdapter } from "../rebalancer/utils/interfaces";
import {
  acrossApi,
  BigNumber,
  BINANCE_NETWORKS,
  CHAIN_IDs,
  ConvertDecimals,
  Contract,
  EvmAddress,
  ERC20,
  MessagingFeeStruct,
  PriceClient,
  SendParamStruct,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  bnZero,
  chainHasNativeToken,
  chainIsSvm,
  chunk,
  coingecko,
  compareAddressesSimple,
  delay,
  defiLlama,
  formatUnits,
  getGasPrice as getOracleGasPrice,
  getEndpointId,
  getMessengerEvm,
  getNativeTokenInfoForChain,
  getProvider,
  getRemoteTokenForL1Token,
  getTokenInfo,
  getTokenInfoFromSymbol,
  isDefined,
  formatToAddress,
  mapAsync,
  roundAmountToSend,
  toBNWei,
  toAddressType,
  truncate,
  winston,
} from "../utils";
import { getAcrossHost } from "../clients/AcrossAPIClient";
import { Options } from "@layerzerolabs/lz-v2-utilities";

export type JussiRateDefinition = { numerator: string; denominator: string };
export type JussiLogicalAssetDefinition = { decimals_by_chain: Record<string, number> };
export type JussiEdgeClassOutputSegmentDefinition = {
  up_to_input_usd: string;
  marginal_output_rate: JussiRateDefinition;
};
export type JussiEdgeCostSegmentDefinition = { up_to_input_usd: string; marginal_cost_per_unit_usd: string };
export type JussiRateLimitBucketCostSegmentDefinition = {
  up_to_usage_usd: string;
  marginal_cost_per_unit_usd: string;
};
export type JussiRateLimitBucketDefinition = {
  bucket_id: string;
  capacity_usd: string;
  window_seconds: number;
  cost_usd: { segments: JussiRateLimitBucketCostSegmentDefinition[] };
};
export type JussiEdgeClassDefinition = {
  edge_class_id: string;
  venue: string;
  input_logical_asset: string;
  output_logical_asset: string;
  output: { segments: JussiEdgeClassOutputSegmentDefinition[] };
  rate_limit_bucket_id?: string;
};
export type JussiNodeDefinition = {
  node_key: string;
  chain_id: number;
  token_address: string;
  symbol: string;
  logical_asset: string;
  decimals: number;
  target_allocation_ratio: string;
  min_allocation_ratio: string;
  max_allocation_ratio: string;
  shortage_cost_usd_per_unit_time?: string;
  surplus_cost_usd_per_unit_time?: string;
};
export type JussiCumulativeBalancePainDefinition = {
  target_balance_native: string;
  min_threshold_native: string;
  max_threshold_native: string;
  surplus_annualized_cost_rate: string;
  deficit_annualized_cost_rate: string;
  out_of_band_severity_multiplier: string;
};
export type JussiEdgeDefinition = {
  edge_id: string;
  edge_class_id: string;
  from_node_key: string;
  to_node_key: string;
  input_capacity_native: string;
  output: { fixed_input_fee_native: string; fixed_output_fee_native: string };
  cost_usd: { fixed_cost_usd: string; segments: JussiEdgeCostSegmentDefinition[] };
  latency_seconds?: number;
};
type JussiPainModel = {
  type: "threshold";
  surplus_annualized_cost_rate: string;
  deficit_annualized_cost_rate: string;
  out_of_band_severity_multiplier: string;
};
export type JussiPutGraphRequest = {
  latency_annualized_cost_rate: string;
  pain_model: JussiPainModel;
  logical_assets: Record<LogicalAsset, JussiLogicalAssetDefinition>;
  cumulative_balance_pain: Record<LogicalAsset, JussiCumulativeBalancePainDefinition>;
  rate_limit_buckets: JussiRateLimitBucketDefinition[];
  edge_classes: JussiEdgeClassDefinition[];
  nodes: JussiNodeDefinition[];
  edges: JussiEdgeDefinition[];
};
export type BuiltJussiGraph = { graphId: string; payload: JussiPutGraphRequest };

type LogicalAsset = "USDC" | "USDT" | "WETH";
type StableLogicalAsset = Exclude<LogicalAsset, "WETH">;
export type JussiGraphEnvelope = { graph_id: string; payload: JussiPutGraphRequest };
export type JussiGraphJson = JussiPutGraphRequest & {
  graph_id: string;
  graph_version: number;
};
type EdgeFamily =
  | "binance"
  | "binance_cex_bridge"
  | "bridgeapi"
  | "canonical"
  | "cctp"
  | "hyperlane"
  | "hyperliquid"
  | "oft";

// prettier-ignore
export type ManagedNodeTemplate = { chainId: number; tokenAddress: string; symbol: string; logicalAsset: LogicalAsset; decimals: number; tokenConfig?: TokenBalanceConfig; managed: boolean };
export type ManagedNodeContext = ManagedNodeTemplate & { nodeKey: string; definition: JussiNodeDefinition };
// prettier-ignore
export type GraphEdgeCandidate = { family: EdgeFamily; adapterOrBridgeName: string; effectiveBridgeName?: string; from: ManagedNodeContext; to: ManagedNodeContext; rebalanceRoute?: RebalanceRoute };
// prettier-ignore
type EdgeEconomics = {
  inputCapacityNative: BigNumber;
  fixedInputFeeNative: BigNumber;
  fixedOutputFeeNative: BigNumber;
  fixedCostUsd: number;
  latencySeconds: number;
};
type CostBreakdown = {
  fixedInputFeeSourceNative: BigNumber;
  fixedOutputFeeDestinationNative: BigNumber;
  fixedCostUsd: number;
  latencySeconds: number;
};
type OftQuoteReader = {
  sharedDecimals(): Promise<number>;
  quoteOFT(
    sendParamStruct: SendParamStruct
  ): Promise<[unknown, Array<{ feeAmountLD: BigNumber | string; description: string }>, { amountReceivedLD: string }]>;
  quoteSend(sendParamStruct: SendParamStruct, payInLzToken: boolean): Promise<MessagingFeeStruct>;
};
export type OftRouteTransferQuote = {
  roundedInputSourceNative: BigNumber;
  amountReceivedDestinationNative: BigNumber;
  messageFeeAssetAddress: string;
  messageFeeAmount: BigNumber;
  sendParamStruct: SendParamStruct;
};
// prettier-ignore
type BridgeBreakdownParams = { baseSigner: Signer; pricingContext: RuntimePricingContext; rebalancerAdapters: Record<string, RebalancerAdapter> };
type ExchangeBreakdownParams = BridgeBreakdownParams & { logger: winston.Logger };
type EdgePricingParams = ExchangeBreakdownParams & {
  cumulativeBalancesByLogicalAsset: Record<LogicalAsset, BigNumber>;
};

type ExchangeBreakdownState = {
  fixedInputFeeSourceNative: BigNumber;
  fixedOutputFeeDestinationNative: BigNumber;
  fixedCostUsd: number;
  sourceBridgeLatencySeconds: number;
  destinationBridgeLatencySeconds: number;
};
type BridgeMatch = { family: EdgeFamily; effectiveBridgeName: string };
type BridgeLookupContext = {
  chainId: number;
  adapterOrBridgeName: string;
  canonicalRemoteToken?: string;
  bridgedRemoteToken?: string;
  nativeUsdc?: string;
  l1SplitterBridges?: { name: string }[];
};

type BinanceInternalAdapter = {
  _getAccountCoins(
    token: string,
    skipCache?: boolean
  ): Promise<{ networkList: Array<{ name: string; withdrawFee: string }> }>;
  _getEntrypointNetwork(chainId: number, token: string): Promise<number>;
  _getLatestPrice(
    sourceToken: string,
    destinationToken: string,
    sourceChain: number,
    amountToTransfer: BigNumber
  ): Promise<{ latestPrice: number; slippagePct: number }>;
  _getSymbol(
    sourceToken: string,
    destinationToken: string
  ): Promise<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    filters: Array<{
      filterType: string;
      tickSize?: string;
      stepSize?: string;
      minQty?: string;
      maxQty?: string;
    }>;
  }>;
  _getTradeFees(): Promise<Array<{ symbol: string; takerCommission: string }>>;
  _getSpotMarketMetaForRoute(
    sourceToken: string,
    destinationToken: string
  ): Promise<{ symbol: string; isBuy: boolean }>;
  _estimateDestinationAmountForRoute(
    sourceToken: string,
    sourceChain: number,
    destinationToken: string,
    destinationChain: number,
    amountToTransfer: BigNumber,
    price: number
  ): Promise<BigNumber>;
};

type HyperliquidInternalAdapter = {
  _getLatestPrice(
    sourceToken: string,
    destinationToken: string,
    destinationChain: number,
    amountToTransfer: BigNumber,
    pxBuffer: number
  ): Promise<{ px: string; slippagePct: number }>;
  _getUserTakerFeePct(skipCache?: boolean): Promise<BigNumber>;
  _getSpotMarketMetaForRoute(sourceToken: string, destinationToken: string): { isBuy: boolean };
};

// prettier-ignore
type BuildGraphParams = { logger: winston.Logger; baseSigner: Signer; relayerConfig: RelayerConfig; inventoryClient: InventoryClient; rebalanceRoutes: RebalanceRoute[]; rebalancerAdapters: Record<string, RebalancerAdapter>; graphId?: string; now?: Date };

const HUB_CHAIN_ID = CHAIN_IDs.MAINNET;
export const JUSSI_GRAPH_VERSION = 4;
export const JUSSI_LOGICAL_ASSETS: readonly LogicalAsset[] = ["USDC", "USDT", "WETH"];
const TRANSIENT_EDGE_PRICING_ERROR_PATTERNS = ["fetch failed", "recvWindow", "Too many requests", "429"];
const EDGE_BUILD_BATCH_SIZE = Math.max(1, Number(process.env.JUSSI_EDGE_BUILD_BATCH_SIZE ?? "8") || 8);
const STABLECOIN_PRICE_USD: Record<StableLogicalAsset, number> = { USDC: 1, USDT: 1 };
const UNIVERSAL_INPUT_TIER_USD = "1000000000.000000";
const EDGE_CLASS_INPUT_USD_SAMPLES = [1_000, 10_000, 100_000] as const;
const EDGE_CLASS_RATE_SEGMENT_THRESHOLD_BPS = 5;
const DEFAULT_LATENCY_ANNUALIZED_COST_RATE = "0.05";
const BINANCE_RATE_LIMIT_BUCKET_ID = "binance_withdrawals_24h_usd";
const SLOW_WITHDRAWAL_LATENCY_SECONDS = 7 * 24 * 60 * 60;
const LINEA_SCROLL_WITHDRAWAL_LATENCY_SECONDS = 4 * 60 * 60;
const ZKSTACK_WITHDRAWAL_LATENCY_SECONDS = 60 * 60;
const MONAD_EXECUTOR_LZ_RECEIVE_GAS_LIMIT = 120_000;
const TOKEN_METADATA_OVERRIDES: Record<string, { decimals: number; priceUsd: number }> = {
  [`${CHAIN_IDs.TEMPO}:${LZ_FEE_TOKENS[CHAIN_IDs.TEMPO].toNative().toLowerCase()}`]: { decimals: 9, priceUsd: 1 },
};
const GAS_UNITS_BY_FAMILY: Record<EdgeFamily, number> = {
  cctp: 250_000,
  oft: 320_000,
  canonical: 280_000,
  binance: 400_000,
  hyperliquid: 380_000,
  binance_cex_bridge: 240_000,
  bridgeapi: 180_000,
  hyperlane: 240_000,
};
const LATENCY_BY_FAMILY: Record<EdgeFamily, number> = {
  cctp: 20 * 60,
  oft: 20 * 60,
  canonical: 20 * 60,
  binance: 5 * 60,
  hyperliquid: 5 * 60,
  binance_cex_bridge: 5 * 60,
  bridgeapi: 5 * 60,
  hyperlane: 20 * 60,
};
const DEFAULT_PAIN_MODEL = {
  type: "threshold" as const,
  surplus_annualized_cost_rate: "0.000219",
  deficit_annualized_cost_rate: "0.002055",
  out_of_band_severity_multiplier: "4.0",
};
const CUMULATIVE_BALANCE_BANDS: Record<
  LogicalAsset,
  { minBps: number; maxBps: number; outOfBandSeverityMultiplier: string }
> = {
  USDC: { minBps: 9_000, maxBps: 11_000, outOfBandSeverityMultiplier: "4.0" },
  USDT: { minBps: 9_000, maxBps: 11_000, outOfBandSeverityMultiplier: "4.0" },
  WETH: { minBps: 9_500, maxBps: 10_500, outOfBandSeverityMultiplier: "8.0" },
};
const DEFAULT_RATE_LIMIT_BUCKETS: JussiRateLimitBucketDefinition[] = [
  {
    bucket_id: BINANCE_RATE_LIMIT_BUCKET_ID,
    capacity_usd: "21000000",
    window_seconds: 86_400,
    cost_usd: {
      segments: [
        { up_to_usage_usd: "12600000", marginal_cost_per_unit_usd: "0" },
        { up_to_usage_usd: "16800000", marginal_cost_per_unit_usd: "0.0005" },
        { up_to_usage_usd: "18900000", marginal_cost_per_unit_usd: "0.0025" },
        { up_to_usage_usd: "20370000", marginal_cost_per_unit_usd: "0.01" },
        { up_to_usage_usd: "21000000", marginal_cost_per_unit_usd: "0.05" },
      ],
    },
  },
];

// Public JSON helpers keep the builder easy to consume from scripts, fixtures, and tests.
export function buildJussiGraphId(now = new Date()): string {
  return `usdc-usdt-weth-${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}`;
}

export function buildJussiGraphEnvelope(graph: BuiltJussiGraph): JussiGraphEnvelope {
  return {
    graph_id: graph.graphId,
    payload: graph.payload,
  };
}

export function buildJussiGraphJson(graph: BuiltJussiGraph): JussiGraphJson {
  return {
    graph_id: graph.graphId,
    graph_version: JUSSI_GRAPH_VERSION,
    latency_annualized_cost_rate: graph.payload.latency_annualized_cost_rate,
    pain_model: graph.payload.pain_model,
    logical_assets: graph.payload.logical_assets,
    cumulative_balance_pain: graph.payload.cumulative_balance_pain,
    rate_limit_buckets: graph.payload.rate_limit_buckets,
    edge_classes: graph.payload.edge_classes,
    nodes: graph.payload.nodes,
    edges: graph.payload.edges,
  };
}

export function canonicalNodeKey(chainId: number, tokenAddress: string): string {
  return `evm:${chainId}:${tokenAddress.toLowerCase()}`;
}

export function resolveBridgeLatencySeconds(
  family: Extract<EdgeFamily, "cctp" | "oft">,
  sourceChain: number,
  logicalAsset: LogicalAsset
): number {
  if (family === "oft" && logicalAsset === "USDT" && sourceChain === CHAIN_IDs.HYPEREVM) {
    return 24 * 60 * 60;
  }
  return LATENCY_BY_FAMILY[family];
}

export function resolveGraphBridgeLatencySeconds(
  candidate: Pick<GraphEdgeCandidate, "family" | "adapterOrBridgeName" | "from" | "to">
): number {
  if (candidate.family === "cctp" || candidate.family === "oft") {
    return resolveBridgeLatencySeconds(candidate.family, candidate.from.chainId, candidate.from.logicalAsset);
  }

  if (candidate.family === "binance_cex_bridge") {
    return LATENCY_BY_FAMILY.binance_cex_bridge;
  }

  if (candidate.from.chainId === HUB_CHAIN_ID) {
    return EXPECTED_L1_TO_L2_MESSAGE_TIME[candidate.to.chainId] ?? LATENCY_BY_FAMILY[candidate.family];
  }

  if (candidate.to.chainId === HUB_CHAIN_ID) {
    if (candidate.adapterOrBridgeName.startsWith("ZKStack") || candidate.adapterOrBridgeName.startsWith("ZkStack")) {
      return ZKSTACK_WITHDRAWAL_LATENCY_SECONDS;
    }
    if (candidate.adapterOrBridgeName.startsWith("Scroll") || candidate.adapterOrBridgeName.startsWith("Linea")) {
      return LINEA_SCROLL_WITHDRAWAL_LATENCY_SECONDS;
    }
    if (
      candidate.adapterOrBridgeName.startsWith("OpStack") ||
      SLOW_WITHDRAWAL_CHAINS.includes(candidate.from.chainId)
    ) {
      return SLOW_WITHDRAWAL_LATENCY_SECONDS;
    }
  }

  return LATENCY_BY_FAMILY[candidate.family];
}

export function resolveExchangeLatencySeconds(params: {
  family: Extract<EdgeFamily, "binance" | "hyperliquid">;
  sourceBridgeLatencySeconds?: number;
  destinationBridgeLatencySeconds?: number;
}): number {
  return (
    LATENCY_BY_FAMILY[params.family] +
    (params.sourceBridgeLatencySeconds ?? 0) +
    (params.destinationBridgeLatencySeconds ?? 0)
  );
}

function buildLogicalAssetDefinitions(
  nodeContexts: ManagedNodeContext[]
): Record<LogicalAsset, JussiLogicalAssetDefinition> {
  return Object.fromEntries(
    JUSSI_LOGICAL_ASSETS.map((logicalAsset) => {
      const decimals_by_chain = Object.fromEntries(
        nodeContexts
          .filter((node) => node.logicalAsset === logicalAsset)
          .map((node) => [String(node.chainId), node.decimals])
          .sort(([a], [b]) => Number(a) - Number(b))
      );
      return [logicalAsset, { decimals_by_chain }];
    })
  ) as Record<LogicalAsset, JussiLogicalAssetDefinition>;
}

// The graph is built in stages: discover all nodes first, then project relayer allocation config into node ratios.
export function buildManagedNodeTemplates(
  inventoryConfig: InventoryConfig,
  hubChainId = HUB_CHAIN_ID
): ManagedNodeTemplate[] {
  const templates = new Map<string, ManagedNodeTemplate>();

  const addTemplate = (template: ManagedNodeTemplate) => {
    const nodeKey = canonicalNodeKey(template.chainId, template.tokenAddress);
    templates.set(nodeKey, template);
  };

  for (const logicalAsset of JUSSI_LOGICAL_ASSETS) {
    const hubTokenInfo = getTokenInfoFromSymbol(logicalAsset, hubChainId);
    addTemplate({
      chainId: hubChainId,
      tokenAddress: hubTokenInfo.address.toNative(),
      symbol: hubTokenInfo.symbol,
      logicalAsset,
      decimals: hubTokenInfo.decimals,
      managed: false,
    });

    const tokenConfig = inventoryConfig.tokenConfig?.[hubTokenInfo.address.toNative()];
    if (!isDefined(tokenConfig)) {
      continue;
    }

    if (isAliasConfig(tokenConfig)) {
      Object.entries(tokenConfig).forEach(([spokeTokenAddress, chainConfig]) => {
        Object.entries(chainConfig).forEach(([chainIdString, balanceConfig]) => {
          const chainId = Number(chainIdString);
          const tokenInfo = getTokenInfo(toAddressType(spokeTokenAddress, chainId), chainId);
          addTemplate({
            chainId,
            tokenAddress: spokeTokenAddress,
            symbol: tokenInfo.symbol,
            logicalAsset,
            decimals: tokenInfo.decimals,
            tokenConfig: balanceConfig,
            managed: true,
          });
        });
      });
      continue;
    }

    Object.entries(tokenConfig).forEach(([chainIdString, balanceConfig]) => {
      const chainId = Number(chainIdString);
      const tokenInfo = getTokenInfoFromSymbol(logicalAsset, chainId);
      addTemplate({
        chainId,
        tokenAddress: tokenInfo.address.toNative(),
        symbol: tokenInfo.symbol,
        logicalAsset,
        decimals: tokenInfo.decimals,
        tokenConfig: balanceConfig,
        managed: true,
      });
    });
  }

  return Array.from(templates.values()).sort((a, b) => a.chainId - b.chainId || a.symbol.localeCompare(b.symbol));
}

export function materializeNodeDefinitions(templates: ManagedNodeTemplate[]): ManagedNodeContext[] {
  return templates.map((template) => {
    const nodeKey = canonicalNodeKey(template.chainId, template.tokenAddress);
    const definition = template.managed ? buildManagedNodeDefinition(template) : buildNeutralNodeDefinition(template);

    return {
      ...template,
      nodeKey,
      definition: {
        ...definition,
        node_key: nodeKey,
      },
    };
  });
}

export async function buildJussiGraphDefinition(params: BuildGraphParams): Promise<BuiltJussiGraph> {
  const { logger, baseSigner, relayerConfig, inventoryClient, rebalanceRoutes, rebalancerAdapters, now } = params;

  const graphId = params.graphId ?? buildJussiGraphId(now);
  const logBuild = (message: string, extra: Record<string, unknown> = {}) =>
    logger.info({ at: "buildGraph.buildJussiGraphDefinition", message, ...extra });
  const debugBuild = (message: string, extra: Record<string, unknown> = {}) =>
    logger.debug({ at: "buildGraph.buildJussiGraphDefinition", message, ...extra });

  logBuild("Starting Jussi graph build", {
    graphId,
    hubChainId: relayerConfig.hubPoolChainId,
    rebalanceRouteCount: rebalanceRoutes.length,
  });
  const cumulativeBalancesByLogicalAsset = Object.fromEntries(
    JUSSI_LOGICAL_ASSETS.map((logicalAsset) => {
      const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[logicalAsset].addresses[relayerConfig.hubPoolChainId]);
      return [logicalAsset, inventoryClient.getCumulativeBalanceWithApproximateUpcomingRefunds(l1Token)];
    })
  ) as Record<LogicalAsset, BigNumber>;
  logBuild("Resolved cumulative balances for logical assets", {
    balances: Object.fromEntries(
      Object.entries(cumulativeBalancesByLogicalAsset).map(([logicalAsset, balance]) => [
        logicalAsset,
        balance.toString(),
      ])
    ),
  });

  logBuild("Building managed node templates");
  const nodeTemplates = buildManagedNodeTemplates(relayerConfig.inventoryConfig, relayerConfig.hubPoolChainId).filter(
    (template) => !chainIsSvm(template.chainId)
  );
  logBuild("Built managed node templates", { nodeTemplateCount: nodeTemplates.length });
  const nodeContexts = materializeNodeDefinitions(nodeTemplates);
  logBuild("Materialized graph nodes", { nodeCount: nodeContexts.length });
  const nodesByKey = new Map(nodeContexts.map((node) => [node.nodeKey, node]));
  logBuild("Building bridge edge candidates", { nodeCount: nodeContexts.length });
  const bridgeCandidates = await buildBridgeEdgeCandidates(nodeContexts);
  logBuild("Built bridge edge candidates", { bridgeCandidateCount: bridgeCandidates.length });
  const rebalanceCandidates = buildRebalanceEdgeCandidates(rebalanceRoutes, nodesByKey);
  logBuild("Built rebalancer edge candidates", { rebalanceCandidateCount: rebalanceCandidates.length });
  const edgeCandidates = dedupeGraphEdgeCandidates([...bridgeCandidates, ...rebalanceCandidates]);
  logBuild("Deduped graph edge candidates", {
    rawCandidateCount: bridgeCandidates.length + rebalanceCandidates.length,
    dedupedEdgeCandidateCount: edgeCandidates.length,
  });

  const pricingContext = new RuntimePricingContext(logger);
  const edgePricingParams = {
    logger,
    baseSigner,
    pricingContext,
    rebalancerAdapters,
    cumulativeBalancesByLogicalAsset,
  };
  const logicalAssets = buildLogicalAssetDefinitions(nodeContexts);
  const edgeClassCandidates = new Map<string, GraphEdgeCandidate>();
  edgeCandidates.forEach((candidate) => {
    const edgeClassId = resolveEdgeClassId(candidate);
    if (!edgeClassCandidates.has(edgeClassId)) {
      edgeClassCandidates.set(edgeClassId, candidate);
    }
  });
  logBuild("Building edge classes", { edgeClassCount: edgeClassCandidates.size });
  const edgeClassDefinitions = new Map(
    (
      await mapAsync(Array.from(edgeClassCandidates.values()), async (candidate) => {
        const edgeClass = await serializeEdgeClassDefinition(candidate, edgePricingParams);
        return [edgeClass.edge_class_id, edgeClass] as const;
      })
    ).sort(([a], [b]) => a.localeCompare(b))
  );
  const edges: JussiEdgeDefinition[] = [];
  const edgeCandidateBatches = chunk(edgeCandidates, EDGE_BUILD_BATCH_SIZE);
  for (let batchIndex = 0; batchIndex < edgeCandidateBatches.length; batchIndex += 1) {
    const edgeCandidateBatch = edgeCandidateBatches[batchIndex];
    logBuild("Constructing edge batch", {
      batchIndex: batchIndex + 1,
      batchCount: edgeCandidateBatches.length,
      batchSize: edgeCandidateBatch.length,
      edgeCount: edgeCandidates.length,
    });
    const builtEdges = await mapAsync(edgeCandidateBatch, async (candidate, candidateIndex) => {
      const edgeIndex = batchIndex * EDGE_BUILD_BATCH_SIZE + candidateIndex + 1;
      debugBuild("Constructing edge", {
        edgeIndex,
        edgeCount: edgeCandidates.length,
        family: candidate.family,
        adapterOrBridgeName: candidate.adapterOrBridgeName,
        fromNodeKey: candidate.from.nodeKey,
        toNodeKey: candidate.to.nodeKey,
      });
      const economics = await estimateEdgeEconomics(candidate, edgePricingParams);
      const edgeClassId = resolveEdgeClassId(candidate);
      const edgeClass = edgeClassDefinitions.get(edgeClassId);
      assert(isDefined(edgeClass), `Missing derived edge class for ${edgeClassId}`);
      const edge = serializeEdgeDefinition(candidate, economics, edgeClass.edge_class_id);
      debugBuild("Constructed edge", {
        edgeIndex,
        edgeCount: edgeCandidates.length,
        edgeId: edge.edge_id,
        edgeClassId: edge.edge_class_id,
        fromNodeKey: edge.from_node_key,
        toNodeKey: edge.to_node_key,
        inputCapacityNative: edge.input_capacity_native,
        fixedCostUsd: edge.cost_usd.fixed_cost_usd,
        latencySeconds: edge.latency_seconds,
      });
      return edge;
    });
    edges.push(...builtEdges);
  }
  logBuild("Finished Jussi graph build", { graphId, nodeCount: nodeContexts.length, edgeCount: edges.length });

  return {
    graphId,
    payload: {
      latency_annualized_cost_rate: DEFAULT_LATENCY_ANNUALIZED_COST_RATE,
      pain_model: DEFAULT_PAIN_MODEL,
      logical_assets: logicalAssets,
      cumulative_balance_pain: buildCumulativeBalancePainDefinitions(cumulativeBalancesByLogicalAsset),
      rate_limit_buckets: Array.from(edgeClassDefinitions.values()).some((edgeClass) =>
        isDefined(edgeClass.rate_limit_bucket_id)
      )
        ? DEFAULT_RATE_LIMIT_BUCKETS
        : [],
      edge_classes: Array.from(edgeClassDefinitions.values()).sort((a, b) =>
        a.edge_class_id.localeCompare(b.edge_class_id)
      ),
      nodes: nodeContexts.map((node) => node.definition),
      edges,
    },
  };
}

function buildManagedNodeDefinition(template: ManagedNodeTemplate): JussiNodeDefinition {
  assert(
    isDefined(template.tokenConfig),
    `Managed node ${template.symbol} on ${template.chainId} is missing token config`
  );
  const maxAllocationRatio = template.tokenConfig.targetPct
    .mul(template.tokenConfig.targetOverageBuffer)
    .div(toBNWei(1));

  return {
    node_key: "",
    chain_id: template.chainId,
    token_address: template.tokenAddress,
    symbol: template.symbol,
    logical_asset: template.logicalAsset,
    decimals: template.decimals,
    target_allocation_ratio: formatUnits(template.tokenConfig.targetPct, 18),
    min_allocation_ratio: formatUnits(template.tokenConfig.thresholdPct, 18),
    max_allocation_ratio: formatUnits(maxAllocationRatio, 18),
  };
}

function buildNeutralNodeDefinition(template: ManagedNodeTemplate): JussiNodeDefinition {
  return {
    node_key: "",
    chain_id: template.chainId,
    token_address: template.tokenAddress,
    symbol: template.symbol,
    logical_asset: template.logicalAsset,
    decimals: template.decimals,
    target_allocation_ratio: "0",
    min_allocation_ratio: "0",
    max_allocation_ratio: "0",
    shortage_cost_usd_per_unit_time: "0",
    surplus_cost_usd_per_unit_time: "0",
  };
}

export function buildCumulativeBalancePainDefinitions(
  cumulativeBalancesByLogicalAsset: Record<LogicalAsset, BigNumber>
): Record<LogicalAsset, JussiCumulativeBalancePainDefinition> {
  return Object.fromEntries(
    JUSSI_LOGICAL_ASSETS.map((logicalAsset) => {
      const targetBalanceNative = cumulativeBalancesByLogicalAsset[logicalAsset];
      const band = CUMULATIVE_BALANCE_BANDS[logicalAsset];
      return [
        logicalAsset,
        {
          target_balance_native: targetBalanceNative.toString(),
          min_threshold_native: targetBalanceNative.mul(band.minBps).div(10_000).toString(),
          max_threshold_native: targetBalanceNative.mul(band.maxBps).div(10_000).toString(),
          surplus_annualized_cost_rate: DEFAULT_PAIN_MODEL.surplus_annualized_cost_rate,
          deficit_annualized_cost_rate: DEFAULT_PAIN_MODEL.deficit_annualized_cost_rate,
          out_of_band_severity_multiplier: band.outOfBandSeverityMultiplier,
        },
      ];
    })
  ) as Record<LogicalAsset, JussiCumulativeBalancePainDefinition>;
}

// Candidate discovery is pure topology: the graph should only contain direct
// inventory bridge actions and direct rebalancer routes. Multi-hop reachability
// should emerge from pathfinding rather than synthetic shortcut edges.
export async function buildBridgeEdgeCandidates(nodeContexts: ManagedNodeContext[]): Promise<GraphEdgeCandidate[]> {
  const nodesByLogicalAssetChain = indexNodesByLogicalAssetAndChain(nodeContexts);
  const hubNodesByLogicalAsset = new Map<LogicalAsset, ManagedNodeContext>(
    JUSSI_LOGICAL_ASSETS.map((logicalAsset) => {
      const hubNode = nodeContexts.find((node) => node.logicalAsset === logicalAsset && node.chainId === HUB_CHAIN_ID);
      assert(isDefined(hubNode), `Missing hub node for ${logicalAsset}`);
      return [logicalAsset, hubNode];
    })
  );
  const candidates: GraphEdgeCandidate[] = [];

  for (const logicalAsset of JUSSI_LOGICAL_ASSETS) {
    const l1Token = TOKEN_SYMBOLS_MAP[logicalAsset].addresses[HUB_CHAIN_ID];
    const chainMap = nodesByLogicalAssetChain.get(logicalAsset) ?? new Map<number, ManagedNodeContext[]>();
    for (const [chainId, chainNodes] of chainMap.entries()) {
      if (chainId === HUB_CHAIN_ID) {
        continue;
      }

      const inboundBridge = CUSTOM_BRIDGE[chainId]?.[l1Token] ?? CANONICAL_BRIDGE[chainId];
      if (isDefined(inboundBridge)) {
        candidates.push(
          ...resolveInboundBridgeCandidates({
            bridgeContext: buildBridgeLookupContext(chainId, logicalAsset, inboundBridge.name),
            chainNodes,
            fromNode: hubNodesByLogicalAsset.get(logicalAsset),
          })
        );
      }

      const outboundBridge = CUSTOM_L2_BRIDGE[chainId]?.[l1Token] ?? CANONICAL_L2_BRIDGE[chainId];
      if (isDefined(outboundBridge)) {
        candidates.push(
          ...resolveOutboundBridgeCandidates({
            bridgeContext: buildBridgeLookupContext(chainId, logicalAsset, outboundBridge.name),
            chainNodes,
            toNode: hubNodesByLogicalAsset.get(logicalAsset),
          })
        );
      }
    }
  }

  return candidates;
}

export async function buildBridgeAdapterRoutes(params: {
  nodeContexts: ManagedNodeContext[];
}): Promise<RebalanceRoute[]> {
  const routes = new Map<string, RebalanceRoute>();
  const bridgeCandidates = await buildBridgeEdgeCandidates(params.nodeContexts);

  bridgeCandidates.forEach((candidate) => {
    const route = toSupportedBridgeAdapterRoute(candidate);
    if (isDefined(route)) {
      routes.set(
        [route.sourceChain, route.sourceToken, route.destinationChain, route.destinationToken, route.adapter].join("|"),
        route
      );
    }
  });

  return Array.from(routes.values());
}

export function resolveOptionalTranslatedTokenAddress(l1Token: EvmAddress, chainId: number): string | undefined {
  const hubUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[HUB_CHAIN_ID];
  if (!compareAddressesSimple(l1Token.toNative(), hubUsdc)) {
    return getRemoteTokenForL1Token(l1Token, chainId, HUB_CHAIN_ID)?.toNative().toLowerCase();
  }

  const bridgedUsdcMapping = Object.values(TOKEN_SYMBOLS_MAP).find(
    ({ symbol, addresses }) =>
      symbol !== "USDC" && compareAddressesSimple(addresses[HUB_CHAIN_ID], l1Token.toNative()) && addresses[chainId]
  );

  return bridgedUsdcMapping?.addresses[chainId]?.toLowerCase();
}

function buildBridgeLookupContext(
  chainId: number,
  logicalAsset: LogicalAsset,
  adapterOrBridgeName: string
): BridgeLookupContext {
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[logicalAsset].addresses[HUB_CHAIN_ID]);
  return {
    chainId,
    adapterOrBridgeName,
    canonicalRemoteToken: getRemoteTokenForL1Token(l1Token, chainId, HUB_CHAIN_ID)?.toNative().toLowerCase(),
    bridgedRemoteToken: resolveOptionalTranslatedTokenAddress(l1Token, chainId),
    nativeUsdc: TOKEN_SYMBOLS_MAP.USDC.addresses[chainId]?.toLowerCase(),
    l1SplitterBridges: TOKEN_SPLITTER_BRIDGES[chainId]?.[l1Token.toNative()],
  };
}

function buildBridgeCandidate(
  match: BridgeMatch | undefined,
  adapterOrBridgeName: string,
  from: ManagedNodeContext,
  to: ManagedNodeContext
): GraphEdgeCandidate[] {
  return isDefined(match)
    ? [{ family: match.family, adapterOrBridgeName, effectiveBridgeName: match.effectiveBridgeName, from, to }]
    : [];
}

function resolveSplitterBridgeMatch(
  node: ManagedNodeContext,
  context: BridgeLookupContext,
  splitterBridges: { name: string }[] | undefined,
  resolveBridgeMatch: (node: ManagedNodeContext, context: BridgeLookupContext) => BridgeMatch | undefined
): BridgeMatch | undefined {
  for (const splitterBridge of splitterBridges ?? []) {
    const match = resolveBridgeMatch(node, {
      ...context,
      adapterOrBridgeName: splitterBridge.name,
      l1SplitterBridges: undefined,
    });
    if (isDefined(match)) {
      return match;
    }
  }
  return undefined;
}

function resolveInboundBridgeMatch(node: ManagedNodeContext, context: BridgeLookupContext): BridgeMatch | undefined {
  const nodeAddress = node.tokenAddress.toLowerCase();

  switch (context.adapterOrBridgeName) {
    case "UsdcTokenSplitterBridge":
      if (nodeAddress === context.nativeUsdc) {
        return { family: "cctp", effectiveBridgeName: "UsdcCCTPBridge" };
      }
      if (nodeAddress === context.canonicalRemoteToken) {
        return {
          family: "canonical",
          effectiveBridgeName: CANONICAL_BRIDGE[context.chainId]?.name ?? "CanonicalBridge",
        };
      }
      return;
    case "TokenSplitterBridge":
      return resolveSplitterBridgeMatch(node, context, context.l1SplitterBridges, resolveInboundBridgeMatch);
    case "UsdcCCTPBridge":
      return nodeAddress === context.nativeUsdc ? { family: "cctp", effectiveBridgeName: "UsdcCCTPBridge" } : undefined;
    case "OFTBridge":
      return nodeAddress === context.bridgedRemoteToken
        ? { family: "oft", effectiveBridgeName: "OFTBridge" }
        : undefined;
    case "BridgeApi":
      return node.symbol === "pathUSD" ? { family: "bridgeapi", effectiveBridgeName: "BridgeApi" } : undefined;
    default:
      return nodeAddress === context.canonicalRemoteToken
        ? { family: familyForBridgeName(context.adapterOrBridgeName), effectiveBridgeName: context.adapterOrBridgeName }
        : undefined;
  }
}

function resolveOutboundBridgeMatch(node: ManagedNodeContext, context: BridgeLookupContext): BridgeMatch | undefined {
  const nodeAddress = node.tokenAddress.toLowerCase();

  switch (context.adapterOrBridgeName) {
    case "UsdcCCTPBridge":
      return nodeAddress === context.nativeUsdc ? { family: "cctp", effectiveBridgeName: "UsdcCCTPBridge" } : undefined;
    case "OFTL2Bridge":
      return nodeAddress === context.bridgedRemoteToken
        ? { family: "oft", effectiveBridgeName: "OFTL2Bridge" }
        : undefined;
    case "BinanceCEXBridge":
    case "BinanceCEXNativeBridge":
      return nodeAddress === context.bridgedRemoteToken
        ? { family: "binance_cex_bridge", effectiveBridgeName: context.adapterOrBridgeName }
        : undefined;
    default:
      return nodeAddress === context.canonicalRemoteToken || nodeAddress === context.nativeUsdc
        ? { family: familyForBridgeName(context.adapterOrBridgeName), effectiveBridgeName: context.adapterOrBridgeName }
        : undefined;
  }
}

function resolveInboundBridgeCandidates(params: {
  bridgeContext: BridgeLookupContext;
  fromNode: ManagedNodeContext;
  chainNodes: ManagedNodeContext[];
}): GraphEdgeCandidate[] {
  const { bridgeContext, fromNode, chainNodes } = params;
  return chainNodes.flatMap((node) =>
    buildBridgeCandidate(
      resolveInboundBridgeMatch(node, bridgeContext),
      bridgeContext.adapterOrBridgeName,
      fromNode,
      node
    )
  );
}

function resolveOutboundBridgeCandidates(params: {
  bridgeContext: BridgeLookupContext;
  toNode: ManagedNodeContext;
  chainNodes: ManagedNodeContext[];
}): GraphEdgeCandidate[] {
  const { bridgeContext, toNode, chainNodes } = params;
  return chainNodes.flatMap((node) =>
    buildBridgeCandidate(
      resolveOutboundBridgeMatch(node, bridgeContext),
      bridgeContext.adapterOrBridgeName,
      node,
      toNode
    )
  );
}

function buildRebalanceEdgeCandidates(
  rebalanceRoutes: RebalanceRoute[],
  nodesByKey: Map<string, ManagedNodeContext>
): GraphEdgeCandidate[] {
  return rebalanceRoutes.flatMap((route) => {
    const sourceTokenInfo = getTokenInfoFromSymbol(route.sourceToken, route.sourceChain);
    const destinationTokenInfo = getTokenInfoFromSymbol(route.destinationToken, route.destinationChain);
    const from = nodesByKey.get(canonicalNodeKey(route.sourceChain, sourceTokenInfo.address.toNative()));
    const to = nodesByKey.get(canonicalNodeKey(route.destinationChain, destinationTokenInfo.address.toNative()));
    if (!isDefined(from) || !isDefined(to)) {
      return [];
    }
    const family =
      route.adapter === "cctp"
        ? "cctp"
        : route.adapter === "oft"
          ? "oft"
          : route.adapter === "binance" && isSameBinanceCoinRoute(route.sourceToken, route.destinationToken)
            ? "binance_cex_bridge"
            : (route.adapter as EdgeFamily);
    return [
      {
        family,
        adapterOrBridgeName: route.adapter,
        from,
        to,
        rebalanceRoute: route,
      } satisfies GraphEdgeCandidate,
    ];
  });
}

function toSupportedBridgeAdapterRoute(candidate: GraphEdgeCandidate): RebalanceRoute | undefined {
  const isSupportedBridgeRoute =
    (candidate.family === "oft" && candidate.from.logicalAsset === "USDT" && candidate.to.logicalAsset === "USDT") ||
    (candidate.family === "cctp" && candidate.from.logicalAsset === "USDC" && candidate.to.logicalAsset === "USDC");
  return isSupportedBridgeRoute
    ? {
        sourceChain: candidate.from.chainId,
        sourceToken: candidate.from.logicalAsset,
        destinationChain: candidate.to.chainId,
        destinationToken: candidate.to.logicalAsset,
        adapter: candidate.family,
      }
    : undefined;
}

export function dedupeGraphEdgeCandidates(candidates: GraphEdgeCandidate[]): GraphEdgeCandidate[] {
  const deduped = new Map<string, GraphEdgeCandidate>();
  for (const candidate of candidates) {
    const key = resolveSerializedEdgeIdentity(candidate);
    deduped.set(key, candidate);
  }
  return Array.from(deduped.values());
}

async function serializeEdgeClassDefinition(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "baseSigner" | "pricingContext" | "rebalancerAdapters">
): Promise<JussiEdgeClassDefinition> {
  const edge_class_id = resolveEdgeClassId(candidate);
  return {
    edge_class_id,
    venue: candidate.family,
    input_logical_asset: candidate.from.logicalAsset,
    output_logical_asset: candidate.to.logicalAsset,
    output: {
      segments: await resolveOutputSegments(candidate, params),
    },
    ...(resolveRateLimitBucketId(candidate.family)
      ? { rate_limit_bucket_id: resolveRateLimitBucketId(candidate.family) }
      : {}),
  };
}

function serializeEdgeDefinition(
  candidate: GraphEdgeCandidate,
  economics: EdgeEconomics,
  edgeClassId: string
): JussiEdgeDefinition {
  return {
    edge_id: resolveSerializedEdgeId(candidate, edgeClassId),
    edge_class_id: edgeClassId,
    from_node_key: candidate.from.nodeKey,
    to_node_key: candidate.to.nodeKey,
    input_capacity_native: economics.inputCapacityNative.toString(),
    output: {
      fixed_input_fee_native: economics.fixedInputFeeNative.toString(),
      fixed_output_fee_native: economics.fixedOutputFeeNative.toString(),
    },
    cost_usd: {
      fixed_cost_usd: formatDecimal(economics.fixedCostUsd),
      segments: [
        {
          up_to_input_usd: UNIVERSAL_INPUT_TIER_USD,
          marginal_cost_per_unit_usd: "0",
        },
      ],
    },
    latency_seconds: economics.latencySeconds,
  };
}

function resolveEdgeClassId(candidate: GraphEdgeCandidate): string {
  const qualifier = candidate.family === "cctp" ? ":standard" : "";
  return `${candidate.family}${qualifier}:${candidate.from.logicalAsset}:${candidate.to.logicalAsset}`;
}

function resolveSerializedEdgeId(candidate: GraphEdgeCandidate, edgeClassId = resolveEdgeClassId(candidate)): string {
  return [edgeClassId, candidate.from.nodeKey, candidate.to.nodeKey].join(":");
}

function resolveSerializedEdgeIdentity(candidate: GraphEdgeCandidate): string {
  return resolveSerializedEdgeId(candidate);
}

function resolveRateLimitBucketId(family: EdgeFamily): string | undefined {
  return family === "binance" || family === "binance_cex_bridge" ? BINANCE_RATE_LIMIT_BUCKET_ID : undefined;
}

async function resolveOutputSegments(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "baseSigner" | "pricingContext" | "rebalancerAdapters">
): Promise<JussiEdgeClassOutputSegmentDefinition[]> {
  if (candidate.family === "oft") {
    return estimateSampledOutputSegments(candidate, params, estimateOftMarginalOutputRateAtUsd);
  }

  if (
    candidate.family === "cctp" ||
    candidate.family === "canonical" ||
    candidate.family === "bridgeapi" ||
    candidate.family === "hyperlane" ||
    candidate.family === "binance_cex_bridge" ||
    candidate.from.logicalAsset === candidate.to.logicalAsset
  ) {
    return [{ up_to_input_usd: UNIVERSAL_INPUT_TIER_USD, marginal_output_rate: { numerator: "1", denominator: "1" } }];
  }

  if (candidate.family === "hyperliquid") {
    return estimateSampledOutputSegments(candidate, params, estimateHyperliquidMarginalOutputRateAtUsd);
  }

  if (candidate.family === "binance") {
    return estimateSampledOutputSegments(candidate, params, estimateBinanceMarginalOutputRateAtUsd);
  }

  return [{ up_to_input_usd: UNIVERSAL_INPUT_TIER_USD, marginal_output_rate: { numerator: "1", denominator: "1" } }];
}

async function estimateSampledOutputSegments(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "baseSigner" | "pricingContext" | "rebalancerAdapters">,
  estimateRateAtUsd: (
    candidate: GraphEdgeCandidate,
    inputUsd: number,
    params: Pick<EdgePricingParams, "baseSigner" | "pricingContext" | "rebalancerAdapters">
  ) => Promise<JussiRateDefinition>
): Promise<JussiEdgeClassOutputSegmentDefinition[]> {
  const samples = await Promise.all(
    EDGE_CLASS_INPUT_USD_SAMPLES.map(async (inputUsd) => ({
      inputUsd,
      rate: await estimateRateAtUsd(candidate, inputUsd, params),
    }))
  );

  const significantSamples: typeof samples = [samples[0]];
  for (const sample of samples.slice(1)) {
    if (
      rateDistanceBps(sample.rate, significantSamples[significantSamples.length - 1].rate) >=
      EDGE_CLASS_RATE_SEGMENT_THRESHOLD_BPS
    ) {
      significantSamples.push(sample);
    }
  }

  if (significantSamples.length === 1) {
    const worstRate = samples.reduce(
      (currentWorst, sample) => minRateDefinition(currentWorst, sample.rate),
      samples[0].rate
    );
    return [{ up_to_input_usd: UNIVERSAL_INPUT_TIER_USD, marginal_output_rate: worstRate }];
  }

  return significantSamples.map((sample, index) => ({
    up_to_input_usd:
      index === significantSamples.length - 1
        ? UNIVERSAL_INPUT_TIER_USD
        : formatInputUsdTier(significantSamples[index + 1].inputUsd),
    marginal_output_rate: sample.rate,
  }));
}

async function estimateBinanceMarginalOutputRateAtUsd(
  candidate: GraphEdgeCandidate,
  inputUsd: number,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">
): Promise<JussiRateDefinition> {
  assert(isDefined(candidate.rebalanceRoute), "Binance edge class estimation requires rebalance route metadata");
  const { sourceToken, destinationToken } = candidate.rebalanceRoute;
  const [forwardRate, reverseRate] = await Promise.all([
    estimateDirectionalBinanceMarginalOutputRate(
      sourceToken as LogicalAsset,
      destinationToken as LogicalAsset,
      inputUsd,
      params
    ),
    estimateDirectionalBinanceMarginalOutputRate(
      destinationToken as LogicalAsset,
      sourceToken as LogicalAsset,
      inputUsd,
      params
    ),
  ]);

  return minRateDefinition(forwardRate, reverseRate);
}

async function estimateDirectionalBinanceMarginalOutputRate(
  sourceToken: LogicalAsset,
  destinationToken: LogicalAsset,
  inputUsd: number,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">
): Promise<JussiRateDefinition> {
  if (sourceToken === destinationToken) {
    return { numerator: "1", denominator: "1" };
  }

  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  const adapterInternals = adapter as unknown as BinanceInternalAdapter;
  const sourceTokenInfo = getTokenInfoFromSymbol(sourceToken, HUB_CHAIN_ID);
  const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, HUB_CHAIN_ID);
  const referenceInputNative = await resolveUsdNotionalInputNative(
    sourceToken,
    sourceTokenInfo.decimals,
    inputUsd,
    params.pricingContext
  );
  const marketMeta = await adapterInternals._getSpotMarketMetaForRoute(sourceToken, destinationToken);
  const { latestPrice } = await adapterInternals._getLatestPrice(
    sourceToken,
    destinationToken,
    HUB_CHAIN_ID,
    referenceInputNative
  );
  const estimatedOutputNative = await adapterInternals._estimateDestinationAmountForRoute(
    sourceToken,
    HUB_CHAIN_ID,
    destinationToken,
    HUB_CHAIN_ID,
    referenceInputNative,
    latestPrice
  );
  const takerCommissionPct =
    Number((await adapterInternals._getTradeFees()).find((fee) => fee.symbol === marketMeta.symbol)?.takerCommission) ||
    0;
  const feeFactor = Math.max(0, 1 - takerCommissionPct / 100);
  const netOutputReadable = parseFloat(formatUnits(estimatedOutputNative, destinationTokenInfo.decimals)) * feeFactor;
  const referenceOutputReadable = await quoteReferenceOutputReadable(
    sourceToken,
    destinationToken,
    referenceInputNative,
    sourceTokenInfo.decimals,
    params.pricingContext
  );
  return decimalToRate(netOutputReadable / Math.max(referenceOutputReadable, Number.EPSILON));
}

async function estimateHyperliquidMarginalOutputRateAtUsd(
  candidate: GraphEdgeCandidate,
  inputUsd: number,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">
): Promise<JussiRateDefinition> {
  assert(isDefined(candidate.rebalanceRoute), "Hyperliquid edge class estimation requires rebalance route metadata");
  const { sourceToken, destinationToken } = candidate.rebalanceRoute;
  const [forwardRate, reverseRate] = await Promise.all([
    estimateDirectionalHyperliquidMarginalOutputRate(
      sourceToken as LogicalAsset,
      destinationToken as LogicalAsset,
      inputUsd,
      params
    ),
    estimateDirectionalHyperliquidMarginalOutputRate(
      destinationToken as LogicalAsset,
      sourceToken as LogicalAsset,
      inputUsd,
      params
    ),
  ]);

  return minRateDefinition(forwardRate, reverseRate);
}

async function estimateDirectionalHyperliquidMarginalOutputRate(
  sourceToken: LogicalAsset,
  destinationToken: LogicalAsset,
  inputUsd: number,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">
): Promise<JussiRateDefinition> {
  if (sourceToken === destinationToken) {
    return { numerator: "1", denominator: "1" };
  }

  const adapter = params.rebalancerAdapters.hyperliquid as RebalancerAdapter;
  const adapterInternals = adapter as unknown as HyperliquidInternalAdapter;
  const sourceTokenInfo = getTokenInfoFromSymbol(sourceToken, HUB_CHAIN_ID);
  const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, HUB_CHAIN_ID);
  const referenceInputNative = await resolveUsdNotionalInputNative(
    sourceToken,
    sourceTokenInfo.decimals,
    inputUsd,
    params.pricingContext
  );
  const { px } = await adapterInternals._getLatestPrice(
    sourceToken,
    destinationToken,
    HUB_CHAIN_ID,
    referenceInputNative,
    1.0
  );
  const spotMarketMeta = adapterInternals._getSpotMarketMetaForRoute(sourceToken, destinationToken);
  const sourceReadable = parseFloat(formatUnits(referenceInputNative, sourceTokenInfo.decimals));
  const executionPrice = Number(px);
  const grossOutputReadable = spotMarketMeta.isBuy ? sourceReadable / executionPrice : sourceReadable * executionPrice;
  const takerFeePct = Number(formatUnits(await adapterInternals._getUserTakerFeePct(), 18));
  const feeFactor = Math.max(0, 1 - takerFeePct / 100);
  const netOutputReadable = parseFloat(
    truncate(grossOutputReadable * feeFactor, destinationTokenInfo.decimals).toString()
  );
  const referenceOutputReadable = await quoteReferenceOutputReadable(
    sourceToken,
    destinationToken,
    referenceInputNative,
    sourceTokenInfo.decimals,
    params.pricingContext
  );
  return decimalToRate(netOutputReadable / Math.max(referenceOutputReadable, Number.EPSILON));
}

export function resolveOftQuoteSendFeeAsset(chainId: number): string {
  if (chainHasNativeToken(chainId)) {
    return getNativeTokenInfoForChain(chainId, HUB_CHAIN_ID).address;
  }

  const lzFeeToken = LZ_FEE_TOKENS[chainId];
  assert(isDefined(lzFeeToken), `Missing LZ fee token mapping for OFT chain ${chainId}`);
  return lzFeeToken.toNative();
}

export function resolveOftQuoteExtraOptions(destinationChain: number): SendParamStruct["extraOptions"] {
  return destinationChain === CHAIN_IDs.MONAD
    ? Options.newOptions().addExecutorLzReceiveOption(MONAD_EXECUTOR_LZ_RECEIVE_GAS_LIMIT).toBytes()
    : "0x";
}

export async function quoteOftRouteTransfer(params: {
  reader: OftQuoteReader;
  originChain: number;
  destinationChain: number;
  sourceDecimals: number;
  recipient: EvmAddress;
  amount: BigNumber;
}): Promise<OftRouteTransferQuote> {
  const { reader, originChain, destinationChain, sourceDecimals, recipient, amount } = params;
  const sharedDecimals = await reader.sharedDecimals();
  const roundedAmount = roundAmountToSend(amount, sourceDecimals, sharedDecimals);
  const sendParamStruct: SendParamStruct = {
    dstEid: getEndpointId(destinationChain),
    to: formatToAddress(recipient),
    amountLD: roundedAmount,
    minAmountLD: roundedAmount,
    extraOptions: resolveOftQuoteExtraOptions(destinationChain),
    composeMsg: "0x",
    oftCmd: "0x",
  };
  const quoteOftResult = (await reader.quoteOFT(sendParamStruct)) as unknown as [
    unknown,
    Array<{ feeAmountLD: BigNumber | string; description: string }>,
    { amountReceivedLD: BigNumber | string },
  ];
  const amountReceivedDestinationNative = BigNumber.from(quoteOftResult[2].amountReceivedLD);
  const finalSendParamStruct: SendParamStruct = {
    ...sendParamStruct,
    minAmountLD: amountReceivedDestinationNative,
  };
  const feeStruct = await reader.quoteSend(finalSendParamStruct, false);

  return {
    roundedInputSourceNative: roundedAmount,
    amountReceivedDestinationNative,
    messageFeeAssetAddress: resolveOftQuoteSendFeeAsset(originChain),
    messageFeeAmount: BigNumber.from(feeStruct.nativeFee),
    sendParamStruct: finalSendParamStruct,
  };
}

async function quoteLiveOftRouteTransfer(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  baseSigner: Signer
): Promise<OftRouteTransferQuote> {
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[candidate.from.logicalAsset].addresses[HUB_CHAIN_ID]);
  const originProvider = await getProvider(candidate.from.chainId);
  const messengerAddress = getMessengerEvm(l1Token, candidate.from.chainId);
  const reader = new Contract(messengerAddress.toNative(), IOFT_ABI_FULL, originProvider) as unknown as OftQuoteReader;

  return quoteOftRouteTransfer({
    reader,
    originChain: candidate.from.chainId,
    destinationChain: candidate.to.chainId,
    sourceDecimals: candidate.from.decimals,
    recipient: EvmAddress.from(await baseSigner.getAddress()),
    amount,
  });
}

async function estimateOftMarginalOutputRateAtUsd(
  candidate: GraphEdgeCandidate,
  inputUsd: number,
  params: Pick<EdgePricingParams, "baseSigner" | "pricingContext">
): Promise<JussiRateDefinition> {
  const referenceInputNative = await resolveUsdNotionalInputNative(
    candidate.from.logicalAsset,
    candidate.from.decimals,
    inputUsd,
    params.pricingContext
  );
  const quote = await quoteLiveOftRouteTransfer(candidate, referenceInputNative, params.baseSigner);
  const outputReadable = parseFloat(formatUnits(quote.amountReceivedDestinationNative, candidate.to.decimals));
  const referenceOutputReadable = await quoteReferenceOutputReadable(
    candidate.from.logicalAsset,
    candidate.to.logicalAsset,
    quote.roundedInputSourceNative,
    candidate.from.decimals,
    params.pricingContext
  );
  return decimalToRate(outputReadable / Math.max(referenceOutputReadable, Number.EPSILON));
}

async function resolveUsdNotionalInputNative(
  logicalAsset: LogicalAsset,
  sourceDecimals: number,
  inputUsd: number,
  pricingContext: RuntimePricingContext
): Promise<BigNumber> {
  const assetPriceUsd = await pricingContext.getLogicalAssetPriceUsd(logicalAsset);
  const inputAmount = inputUsd / Math.max(assetPriceUsd, Number.EPSILON);
  return toBNWei(truncate(inputAmount, sourceDecimals).toString(), sourceDecimals);
}

async function quoteReferenceOutputReadable(
  inputLogicalAsset: LogicalAsset,
  outputLogicalAsset: LogicalAsset,
  inputNative: BigNumber,
  inputDecimals: number,
  pricingContext: RuntimePricingContext
): Promise<number> {
  const inputReadable = parseFloat(formatUnits(inputNative, inputDecimals));
  if (inputLogicalAsset === outputLogicalAsset) {
    return inputReadable;
  }
  const [inputPriceUsd, outputPriceUsd] = await Promise.all([
    pricingContext.getLogicalAssetPriceUsd(inputLogicalAsset),
    pricingContext.getLogicalAssetPriceUsd(outputLogicalAsset),
  ]);
  return (inputReadable * inputPriceUsd) / Math.max(outputPriceUsd, Number.EPSILON);
}

function decimalToRate(value: number): JussiRateDefinition {
  const denominator = 1_000_000;
  const clamped = Math.max(0, Math.min(1, value));
  return {
    numerator: Math.round(clamped * denominator).toString(),
    denominator: denominator.toString(),
  };
}

function minRateDefinition(left: JussiRateDefinition, right: JussiRateDefinition): JussiRateDefinition {
  return rateToDecimal(left) <= rateToDecimal(right) ? left : right;
}

function rateToDecimal(rate: JussiRateDefinition): number {
  return Number(rate.numerator) / Math.max(Number(rate.denominator), Number.EPSILON);
}

function rateDistanceBps(left: JussiRateDefinition, right: JussiRateDefinition): number {
  return Math.abs(rateToDecimal(left) - rateToDecimal(right)) * 10_000;
}

function formatInputUsdTier(value: number): string {
  return value.toFixed(6);
}

async function estimateEdgeEconomics(
  candidate: GraphEdgeCandidate,
  params: EdgePricingParams,
  attempt = 0
): Promise<EdgeEconomics> {
  try {
    const referenceInputNative = await resolveInputCapacityNative(candidate, params);
    const breakdown =
      candidate.family === "binance"
        ? await estimateBinanceSwapBreakdown(candidate, referenceInputNative, params)
        : candidate.family === "hyperliquid"
          ? await estimateHyperliquidSwapBreakdown(candidate, referenceInputNative, params)
          : candidate.family === "cctp"
            ? await estimateCctpBreakdown(candidate, referenceInputNative, params)
            : candidate.family === "oft"
              ? await estimateOftBreakdown(candidate, referenceInputNative, params)
              : candidate.family === "binance_cex_bridge"
                ? await estimateBinanceCexBridgeBreakdown(candidate, params)
                : candidate.family === "bridgeapi"
                  ? await estimateBridgeApiBreakdown(candidate, params)
                  : await estimateQuotedBridgeBreakdown(
                      candidate,
                      referenceInputNative,
                      params,
                      candidate.family === "hyperlane" ? "hyperlane" : "canonical"
                    );

    return {
      inputCapacityNative: referenceInputNative,
      fixedInputFeeNative: minBigNumber(breakdown.fixedInputFeeSourceNative, referenceInputNative),
      fixedOutputFeeNative: breakdown.fixedOutputFeeDestinationNative,
      fixedCostUsd: breakdown.fixedCostUsd,
      latencySeconds: breakdown.latencySeconds,
    };
  } catch (error) {
    const errorText = error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error);
    if (attempt >= 3 || !TRANSIENT_EDGE_PRICING_ERROR_PATTERNS.some((pattern) => errorText.includes(pattern))) {
      throw error;
    }

    params.logger.warn({
      at: "buildGraph.estimateEdgeEconomics",
      message: "Retrying transient edge pricing failure",
      attempt: attempt + 1,
      family: candidate.family,
      fromNodeKey: candidate.from.nodeKey,
      toNodeKey: candidate.to.nodeKey,
      error: error instanceof Error ? error.message : String(error),
    });
    await delay(2 ** attempt + Math.random());
    return estimateEdgeEconomics(candidate, params, attempt + 1);
  }
}

async function resolveInputCapacityNative(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters" | "cumulativeBalancesByLogicalAsset">
): Promise<BigNumber> {
  if (candidate.family === "cctp") {
    return CCTP_MAX_SEND_AMOUNT;
  }

  return resolveEffectivelyUnlimitedCapacityNative(
    candidate.from.logicalAsset,
    candidate.from.decimals,
    params.pricingContext
  );
}

async function resolveEffectivelyUnlimitedCapacityNative(
  logicalAsset: LogicalAsset,
  decimals: number,
  pricingContext: RuntimePricingContext
): Promise<BigNumber> {
  return resolveUsdNotionalInputNative(logicalAsset, decimals, Number(UNIVERSAL_INPUT_TIER_USD), pricingContext);
}

async function estimateCctpBreakdown(
  candidate: GraphEdgeCandidate,
  _amount: BigNumber,
  params: BridgeBreakdownParams
): Promise<CostBreakdown> {
  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: await params.pricingContext.deriveGasFloorUsd(candidate.family, candidate.from.chainId),
    latencySeconds: resolveGraphBridgeLatencySeconds(candidate),
  };
}

async function estimateOftBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: BridgeBreakdownParams
): Promise<CostBreakdown> {
  const [gasFloorUsd, oftRouteQuote] = await Promise.all([
    params.pricingContext.deriveGasFloorUsd(candidate.family, candidate.from.chainId),
    quoteLiveOftRouteTransfer(candidate, amount, params.baseSigner),
  ]);
  const quotedMessageFeeUsd = await params.pricingContext.tokenValueToUsd(
    oftRouteQuote.messageFeeAmount,
    candidate.from.chainId,
    oftRouteQuote.messageFeeAssetAddress
  );

  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: gasFloorUsd + quotedMessageFeeUsd,
    latencySeconds: resolveBridgeLatencySeconds("oft", candidate.from.chainId, candidate.from.logicalAsset),
  };
}

async function estimateBridgeRouteBreakdown(
  token: LogicalAsset,
  sourceChain: number,
  destinationChain: number,
  amount: BigNumber,
  params: BridgeBreakdownParams
): Promise<CostBreakdown> {
  const syntheticCandidate = buildSyntheticBridgeCandidate(token, sourceChain, destinationChain);
  if (token === "USDC") {
    return estimateCctpBreakdown(syntheticCandidate, amount, params);
  }
  if (token === "USDT") {
    return estimateOftBreakdown(syntheticCandidate, amount, params);
  }
  throw new Error(`Unsupported intermediate bridge token for exchange route: ${token}`);
}

async function estimateBinanceSwapBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: ExchangeBreakdownParams
): Promise<CostBreakdown> {
  assert(isDefined(candidate.rebalanceRoute), "Binance swap edge is missing rebalance route");
  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  const adapterInternals = adapter as unknown as BinanceInternalAdapter;
  const { sourceToken, destinationToken, sourceChain, destinationChain } = candidate.rebalanceRoute;
  const destinationCoin = await adapterInternals._getAccountCoins(destinationToken);
  const destinationEntrypointNetwork = await adapterInternals._getEntrypointNetwork(destinationChain, destinationToken);
  const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationEntrypointNetwork);
  const withdrawNetwork = BINANCE_NETWORKS[destinationEntrypointNetwork];
  const withdrawNetworkConfig =
    destinationCoin.networkList.find((network: { name: string }) => network.name === withdrawNetwork) ??
    destinationCoin.networkList[0];
  const withdrawFee = toBNWei(withdrawNetworkConfig.withdrawFee, destinationTokenInfo.decimals);
  const state = await initializeExchangeBreakdown(candidate, params.pricingContext);
  state.fixedOutputFeeDestinationNative = ConvertDecimals(
    destinationTokenInfo.decimals,
    candidate.to.decimals
  )(withdrawFee);

  const sourceEntrypointNetwork = await adapterInternals._getEntrypointNetwork(sourceChain, sourceToken);
  if (sourceEntrypointNetwork !== sourceChain) {
    await addBridgeLegToExchangeBreakdown(state, candidate, amount, params, {
      side: "source",
      token: sourceToken as LogicalAsset,
      sourceChain,
      destinationChain: sourceEntrypointNetwork,
      sourceDecimals: candidate.from.decimals,
    });
  }

  if (destinationEntrypointNetwork !== destinationChain) {
    await addBridgeLegToExchangeBreakdown(state, candidate, amount, params, {
      side: "destination",
      token: destinationToken as LogicalAsset,
      sourceChain: destinationEntrypointNetwork,
      destinationChain,
      sourceDecimals: getTokenInfoFromSymbol(destinationToken, destinationEntrypointNetwork).decimals,
    });
  }
  return finalizeExchangeBreakdown(state, "binance");
}

async function estimateHyperliquidSwapBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: ExchangeBreakdownParams
): Promise<CostBreakdown> {
  assert(isDefined(candidate.rebalanceRoute), "Hyperliquid swap edge is missing rebalance route");
  const { sourceToken, destinationToken, sourceChain, destinationChain } = candidate.rebalanceRoute;
  const state = await initializeExchangeBreakdown(candidate, params.pricingContext);

  if (sourceChain !== CHAIN_IDs.HYPEREVM) {
    await addBridgeLegToExchangeBreakdown(state, candidate, amount, params, {
      side: "source",
      token: sourceToken as LogicalAsset,
      sourceChain,
      destinationChain: CHAIN_IDs.HYPEREVM,
      sourceDecimals: candidate.from.decimals,
    });
  }

  if (destinationChain !== CHAIN_IDs.HYPEREVM) {
    await addBridgeLegToExchangeBreakdown(state, candidate, amount, params, {
      side: "destination",
      token: destinationToken as LogicalAsset,
      sourceChain: CHAIN_IDs.HYPEREVM,
      destinationChain,
      sourceDecimals: getTokenInfoFromSymbol(destinationToken, CHAIN_IDs.HYPEREVM).decimals,
    });
  }
  return finalizeExchangeBreakdown(state, "hyperliquid");
}

async function estimateBinanceCexBridgeBreakdown(
  candidate: GraphEdgeCandidate,
  params: Pick<BridgeBreakdownParams, "pricingContext" | "rebalancerAdapters">
): Promise<CostBreakdown> {
  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  const adapterInternals = adapter as unknown as BinanceInternalAdapter;
  const tokenSymbol = candidate.from.logicalAsset;
  const network =
    BINANCE_NETWORKS[candidate.to.chainId] ??
    BINANCE_NETWORKS[candidate.from.chainId] ??
    BINANCE_NETWORKS[HUB_CHAIN_ID];
  const coin = await adapterInternals._getAccountCoins(tokenSymbol);
  const withdrawFeeConfig = coin.networkList.find((entry) => entry.name === network);
  assert(
    isDefined(withdrawFeeConfig),
    `Withdraw fee config not found for ${tokenSymbol} on Binance network ${network}`
  );

  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: toBNWei(withdrawFeeConfig.withdrawFee, candidate.to.decimals),
    fixedCostUsd: await params.pricingContext.deriveGasFloorUsd(candidate.family, candidate.from.chainId),
    latencySeconds: resolveGraphBridgeLatencySeconds(candidate),
  };
}

async function estimateBridgeApiBreakdown(
  candidate: GraphEdgeCandidate,
  params: Pick<BridgeBreakdownParams, "pricingContext">
): Promise<CostBreakdown> {
  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: await params.pricingContext.deriveGasFloorUsd(candidate.family, candidate.from.chainId),
    latencySeconds: LATENCY_BY_FAMILY.bridgeapi,
  };
}

async function estimateQuotedBridgeBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: Pick<BridgeBreakdownParams, "baseSigner" | "pricingContext">,
  family: EdgeFamily
): Promise<CostBreakdown> {
  const quotedFeeUsd = await quoteNativeBridgeFeeUsd(candidate, amount, params);
  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: Math.max(quotedFeeUsd, await params.pricingContext.deriveGasFloorUsd(family, candidate.from.chainId)),
    latencySeconds: resolveGraphBridgeLatencySeconds(candidate),
  };
}

function buildSyntheticBridgeCandidate(
  logicalAsset: LogicalAsset,
  sourceChain: number,
  destinationChain: number
): GraphEdgeCandidate {
  const family = logicalAsset === "USDC" ? "cctp" : logicalAsset === "USDT" ? "oft" : undefined;
  assert(isDefined(family), `Synthetic bridge candidate not supported for ${logicalAsset}`);
  return {
    family,
    adapterOrBridgeName: family,
    from: buildSyntheticBridgeNode(logicalAsset, sourceChain),
    to: buildSyntheticBridgeNode(logicalAsset, destinationChain),
  } as GraphEdgeCandidate;
}

function buildSyntheticBridgeNode(logicalAsset: LogicalAsset, chainId: number): ManagedNodeContext {
  const tokenInfo = getTokenInfoFromSymbol(logicalAsset, chainId);
  return {
    chainId,
    tokenAddress: tokenInfo.address.toNative(),
    symbol: tokenInfo.symbol,
    nodeKey: canonicalNodeKey(chainId, tokenInfo.address.toNative()),
    decimals: tokenInfo.decimals,
    logicalAsset,
  } as ManagedNodeContext;
}

async function initializeExchangeBreakdown(
  candidate: GraphEdgeCandidate,
  pricingContext: RuntimePricingContext
): Promise<ExchangeBreakdownState> {
  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: await pricingContext.deriveGasFloorUsd(candidate.family, candidate.from.chainId),
    sourceBridgeLatencySeconds: 0,
    destinationBridgeLatencySeconds: 0,
  };
}

async function addBridgeLegToExchangeBreakdown(
  state: ExchangeBreakdownState,
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: BridgeBreakdownParams,
  leg: {
    side: "source" | "destination";
    token: LogicalAsset;
    sourceChain: number;
    destinationChain: number;
    sourceDecimals: number;
  }
): Promise<void> {
  const bridgeBreakdown = await estimateBridgeRouteBreakdown(
    leg.token,
    leg.sourceChain,
    leg.destinationChain,
    amount,
    params
  );
  if (leg.side === "source") {
    state.fixedInputFeeSourceNative = state.fixedInputFeeSourceNative.add(bridgeBreakdown.fixedInputFeeSourceNative);
  } else {
    state.fixedOutputFeeDestinationNative = state.fixedOutputFeeDestinationNative.add(
      ConvertDecimals(leg.sourceDecimals, candidate.to.decimals)(bridgeBreakdown.fixedOutputFeeDestinationNative)
    );
  }
  state.fixedCostUsd += bridgeBreakdown.fixedCostUsd;
  if (leg.side === "source") {
    state.sourceBridgeLatencySeconds = bridgeBreakdown.latencySeconds;
  } else {
    state.destinationBridgeLatencySeconds = bridgeBreakdown.latencySeconds;
  }
}

function finalizeExchangeBreakdown(
  state: ExchangeBreakdownState,
  family: Extract<EdgeFamily, "binance" | "hyperliquid">
): CostBreakdown {
  return {
    fixedInputFeeSourceNative: state.fixedInputFeeSourceNative,
    fixedOutputFeeDestinationNative: state.fixedOutputFeeDestinationNative,
    fixedCostUsd: state.fixedCostUsd,
    latencySeconds: resolveExchangeLatencySeconds({
      family,
      sourceBridgeLatencySeconds: state.sourceBridgeLatencySeconds,
      destinationBridgeLatencySeconds: state.destinationBridgeLatencySeconds,
    }),
  };
}

async function quoteNativeBridgeFeeUsd(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: Pick<BridgeBreakdownParams, "baseSigner" | "pricingContext">
): Promise<number> {
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[candidate.from.logicalAsset].addresses[HUB_CHAIN_ID]);
  if (candidate.to.chainId === HUB_CHAIN_ID) {
    const constructor =
      CUSTOM_L2_BRIDGE[candidate.from.chainId]?.[l1Token.toNative()] ?? CANONICAL_L2_BRIDGE[candidate.from.chainId];
    if (!isDefined(constructor)) {
      return 0;
    }
    const l2Provider = await getProvider(candidate.from.chainId);
    const l2SignerOrProvider = chainIsSvm(candidate.from.chainId) ? l2Provider : params.baseSigner.connect(l2Provider);
    const l1Signer = params.baseSigner.connect(await getProvider(HUB_CHAIN_ID));
    const bridge = new constructor(candidate.from.chainId, HUB_CHAIN_ID, l2SignerOrProvider, l1Signer, l1Token);
    const txns = await bridge.constructWithdrawToL1Txns(
      EvmAddress.from(await params.baseSigner.getAddress()),
      toAddressType(candidate.from.tokenAddress, candidate.from.chainId),
      l1Token,
      amount
    );
    let totalUsd = 0;
    for (const txn of txns as { value?: BigNumber; chainId?: number }[]) {
      totalUsd += await params.pricingContext.nativeValueToUsd(
        txn.value ?? bnZero,
        txn.chainId ?? candidate.from.chainId
      );
    }
    return totalUsd;
  }

  const constructor =
    CUSTOM_BRIDGE[candidate.to.chainId]?.[l1Token.toNative()] ?? CANONICAL_BRIDGE[candidate.to.chainId];
  if (!isDefined(constructor)) {
    return 0;
  }
  const l1Signer = params.baseSigner.connect(await getProvider(HUB_CHAIN_ID));
  const l2Provider = await getProvider(candidate.to.chainId);
  const bridge = new constructor(
    candidate.to.chainId,
    HUB_CHAIN_ID,
    l1Signer,
    l2Provider,
    l1Token,
    params.pricingContext.logger
  );
  const txn = await bridge.constructL1ToL2Txn(
    EvmAddress.from(await params.baseSigner.getAddress()),
    l1Token,
    toAddressType(candidate.to.tokenAddress, candidate.to.chainId),
    amount
  );
  return params.pricingContext.nativeValueToUsd(txn.value ?? bnZero, HUB_CHAIN_ID);
}

function indexNodesByLogicalAssetAndChain(
  nodeContexts: ManagedNodeContext[]
): Map<LogicalAsset, Map<number, ManagedNodeContext[]>> {
  const index = new Map<LogicalAsset, Map<number, ManagedNodeContext[]>>();
  for (const node of nodeContexts) {
    const logicalAssetIndex = index.get(node.logicalAsset) ?? new Map<number, ManagedNodeContext[]>();
    const chainNodes = logicalAssetIndex.get(node.chainId) ?? [];
    chainNodes.push(node);
    logicalAssetIndex.set(node.chainId, chainNodes);
    index.set(node.logicalAsset, logicalAssetIndex);
  }
  return index;
}

function familyForBridgeName(bridgeName: string): EdgeFamily {
  if (bridgeName.includes("CCTP")) {
    return "cctp";
  }
  if (bridgeName.includes("OFT")) {
    return "oft";
  }
  if (bridgeName.includes("Hyperlane")) {
    return "hyperlane";
  }
  if (bridgeName.includes("BridgeApi")) {
    return "bridgeapi";
  }
  if (bridgeName.includes("Binance")) {
    return "binance_cex_bridge";
  }
  return "canonical";
}

function minBigNumber(a: BigNumber, b: BigNumber): BigNumber {
  return a.lte(b) ? a : b;
}

function formatDecimal(value: number): string {
  const normalized = Number.isFinite(value) ? value : 0;
  return normalized.toFixed(12).replace(/\.?0+$/, "") || "0";
}

class RuntimePricingContext {
  private readonly priceClient: PriceClient;
  private readonly gasPriceCache = new Map<number, Promise<BigNumber>>();
  private readonly nativePriceCache = new Map<number, Promise<number>>();
  private readonly logicalAssetPriceCache = new Map<LogicalAsset, Promise<number>>();
  private readonly tokenPriceCache = new Map<string, Promise<number>>();
  private readonly tokenDecimalsCache = new Map<string, Promise<number>>();

  constructor(readonly logger: winston.Logger) {
    this.priceClient = new PriceClient(logger, [
      new acrossApi.PriceFeed({ host: getAcrossHost(HUB_CHAIN_ID) }),
      new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
      new defiLlama.PriceFeed(),
    ]);
  }

  async deriveGasFloorUsd(family: EdgeFamily, chainId: number): Promise<number> {
    const gasUnits = GAS_UNITS_BY_FAMILY[family];
    const gasPrice = await this.getGasPrice(chainId);
    const nativePriceUsd = await this.getNativeTokenPriceUsd(chainId);
    const nativeTokenInfo = getNativeTokenInfoForChain(chainId, HUB_CHAIN_ID);
    const gasCostNative = gasPrice.mul(gasUnits);
    return parseFloat(formatUnits(gasCostNative, nativeTokenInfo.decimals)) * nativePriceUsd;
  }

  async nativeValueToUsd(value: BigNumber, chainId: number): Promise<number> {
    if (!value.gt(bnZero)) {
      return 0;
    }
    const nativeTokenInfo = getNativeTokenInfoForChain(chainId, HUB_CHAIN_ID);
    const nativePriceUsd = await this.getNativeTokenPriceUsd(chainId);
    return parseFloat(formatUnits(value, nativeTokenInfo.decimals)) * nativePriceUsd;
  }

  async tokenValueToUsd(value: BigNumber, chainId: number, tokenAddress: string): Promise<number> {
    if (!value.gt(bnZero)) {
      return 0;
    }

    const [decimals, tokenPriceUsd] = await Promise.all([
      this.getTokenDecimals(chainId, tokenAddress),
      this.getTokenPriceUsd(chainId, tokenAddress),
    ]);
    return parseFloat(formatUnits(value, decimals)) * tokenPriceUsd;
  }

  async getLogicalAssetPriceUsd(logicalAsset: LogicalAsset): Promise<number> {
    if (logicalAsset === "USDC" || logicalAsset === "USDT") {
      return STABLECOIN_PRICE_USD[logicalAsset];
    }
    return this.loadCachedValue(this.logicalAssetPriceCache, logicalAsset, async () => {
      const tokenInfo = getTokenInfoFromSymbol(logicalAsset, HUB_CHAIN_ID);
      const price = await this.priceClient.getPriceByAddress(tokenInfo.address.toNative());
      return Number(price.price);
    });
  }

  private getGasPrice(chainId: number): Promise<BigNumber> {
    return this.loadCachedValue(this.gasPriceCache, chainId, async () => {
      try {
        const provider = await getProvider(chainId);
        const feeData = await getOracleGasPrice(provider, 1, 1);
        const resolved = feeData.maxFeePerGas ?? feeData.maxPriorityFeePerGas;
        assert(
          isDefined(resolved) && resolved.gt(bnZero),
          `Gas price oracle returned no usable gas price for ${chainId}`
        );
        return resolved;
      } catch (error) {
        this.logger.error({
          at: "buildGraph.RuntimePricingContext.getGasPrice",
          message: "Failed to query gas price from gasPriceOracle",
          chainId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  private getNativeTokenPriceUsd(chainId: number): Promise<number> {
    return this.loadCachedValue(this.nativePriceCache, chainId, async () => {
      try {
        const nativeTokenInfo = getNativeTokenInfoForChain(chainId, HUB_CHAIN_ID);
        const price = await this.priceClient.getPriceByAddress(nativeTokenInfo.address);
        return Number(price.price);
      } catch (error) {
        this.logger.warn({
          at: "buildGraph.RuntimePricingContext.getNativeTokenPriceUsd",
          message: "Failed to query native token USD price, using $1 fallback",
          chainId,
          error: error instanceof Error ? error.message : String(error),
        });
        return 1;
      }
    });
  }

  private getTokenDecimals(chainId: number, tokenAddress: string): Promise<number> {
    const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
    return this.loadCachedValue(this.tokenDecimalsCache, cacheKey, async () => {
      const metadataOverride = TOKEN_METADATA_OVERRIDES[cacheKey];
      if (isDefined(metadataOverride)) {
        return metadataOverride.decimals;
      }
      try {
        return getTokenInfo(EvmAddress.from(tokenAddress), chainId).decimals;
      } catch {
        const provider = await getProvider(chainId);
        const token = new Contract(tokenAddress, ERC20.abi, provider);
        return Number(await token.decimals());
      }
    });
  }

  private getTokenPriceUsd(chainId: number, tokenAddress: string): Promise<number> {
    const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
    return this.loadCachedValue(this.tokenPriceCache, cacheKey, async () => {
      const metadataOverride = TOKEN_METADATA_OVERRIDES[cacheKey];
      if (isDefined(metadataOverride)) {
        return metadataOverride.priceUsd;
      }
      try {
        const price = await this.priceClient.getPriceByAddress(tokenAddress);
        return Number(price.price);
      } catch (error) {
        this.logger.warn({
          at: "buildGraph.RuntimePricingContext.getTokenPriceUsd",
          message: "Failed to query token USD price, using $1 fallback",
          chainId,
          tokenAddress,
          error: error instanceof Error ? error.message : String(error),
        });
        return 1;
      }
    });
  }

  private loadCachedValue<K, T>(cache: Map<K, Promise<T>>, key: K, loader: () => Promise<T>): Promise<T> {
    const cached = cache.get(key);
    if (isDefined(cached)) {
      return cached;
    }
    const pending = loader().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  }
}
