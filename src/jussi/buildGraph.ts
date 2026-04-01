import {
  CANONICAL_BRIDGE,
  CANONICAL_L2_BRIDGE,
  CCTP_MAX_SEND_AMOUNT,
  CUSTOM_BRIDGE,
  CUSTOM_L2_BRIDGE,
  TOKEN_SPLITTER_BRIDGES,
} from "../common";
import { InventoryClient } from "../clients";
import { InventoryConfig, TokenBalanceConfig, isAliasConfig } from "../interfaces/InventoryManagement";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { BinanceStablecoinSwapAdapter } from "../rebalancer/adapters/binance";
import { HyperliquidStablecoinSwapAdapter } from "../rebalancer/adapters/hyperliquid";
import { OftAdapter } from "../rebalancer/adapters/oftAdapter";
import { RebalancerConfig } from "../rebalancer/RebalancerConfig";
import { RebalanceRoute, RebalancerAdapter } from "../rebalancer/utils/interfaces";
import {
  acrossApi,
  Address,
  BigNumber,
  BINANCE_NETWORKS,
  CHAIN_IDs,
  ConvertDecimals,
  EvmAddress,
  PriceClient,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  bnZero,
  chainIsSvm,
  coingecko,
  compareAddressesSimple,
  delay,
  defiLlama,
  formatUnits,
  getGasPrice as getOracleGasPrice,
  getNativeTokenInfoForChain,
  getProvider,
  getRemoteTokenForL1Token,
  getTokenInfo,
  getTokenInfoFromSymbol,
  isDefined,
  toBN,
  toBNWei,
  toAddressType,
  winston,
} from "../utils";
import { getAcrossHost } from "../clients/AcrossAPIClient";

export type JussiRateDefinition = {
  numerator: string;
  denominator: string;
};

export type JussiOutputSegmentDefinition = {
  up_to_input_native: string;
  marginal_output_rate: JussiRateDefinition;
};

export type JussiCostSegmentDefinition = {
  up_to_input_native: string;
  marginal_cost_per_unit_usd: string;
};

export type JussiNodeDefinition = {
  node_key: string;
  chain_id: number;
  token_address: string;
  symbol: string;
  logical_asset: string;
  decimals: number;
  target_balance_native: string;
  min_threshold_native: string;
  max_threshold_native: string;
  shortage_cost_usd_per_unit_time?: string;
  surplus_cost_usd_per_unit_time?: string;
};

export type JussiEdgeDefinition = {
  edge_id: string;
  from_node_key: string;
  to_node_key: string;
  input_capacity_native: string;
  output: {
    segments: JussiOutputSegmentDefinition[];
  };
  cost_usd: {
    fixed_cost_usd: string;
    segments: JussiCostSegmentDefinition[];
  };
  latency_seconds?: number;
};

export type JussiPutGraphRequest = {
  pain_model?: {
    type: "threshold";
    surplus_annualized_cost_rate: string;
    surplus_expected_stale_time_secs: number;
    deficit_annualized_cost_rate: string;
    deficit_expected_stale_time_secs: number;
    out_of_band_severity_multiplier: string;
  };
  nodes: JussiNodeDefinition[];
  edges: JussiEdgeDefinition[];
};

export type BuiltJussiGraph = {
  graphId: string;
  payload: JussiPutGraphRequest;
};

type LogicalAsset = "USDC" | "USDT";
type EdgeFamily =
  | "binance"
  | "binance_cex_bridge"
  | "bridgeapi"
  | "canonical"
  | "cctp"
  | "hyperlane"
  | "hyperliquid"
  | "oft";

export type ManagedNodeTemplate = {
  chainId: number;
  tokenAddress: string;
  symbol: string;
  logicalAsset: LogicalAsset;
  decimals: number;
  tokenConfig?: TokenBalanceConfig;
  managed: boolean;
};

export type ManagedNodeContext = ManagedNodeTemplate & {
  nodeKey: string;
  definition: JussiNodeDefinition;
};

export type GraphEdgeCandidate = {
  family: EdgeFamily;
  adapterOrBridgeName: string;
  effectiveBridgeName?: string;
  from: ManagedNodeContext;
  to: ManagedNodeContext;
  rebalanceRoute?: RebalanceRoute;
};

type EdgeEconomics = {
  inputCapacityNative: BigNumber;
  expectedOutputNative: BigNumber;
  additiveCostUsd: number;
  latencySeconds: number;
};

type CostBreakdown = {
  tokenLossSourceNative: BigNumber;
  additiveCostUsd: number;
  latencySeconds: number;
};

type BuildGraphParams = {
  logger: winston.Logger;
  baseSigner: Signer;
  relayerConfig: RelayerConfig;
  rebalancerConfig: RebalancerConfig;
  inventoryClient: InventoryClient;
  rebalanceRoutes: RebalanceRoute[];
  rebalancerAdapters: Record<string, RebalancerAdapter>;
  graphId?: string;
  now?: Date;
};

const HUB_CHAIN_ID = CHAIN_IDs.MAINNET;
const LOGICAL_ASSETS: readonly LogicalAsset[] = ["USDC", "USDT"];
const TRANSIENT_EDGE_PRICING_ERROR_PATTERNS = ["fetch failed", "recvWindow", "Too many requests", "429"];
const STABLECOIN_PRICE_USD: Record<LogicalAsset, number> = { USDC: 1, USDT: 1 };
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
  surplus_annualized_cost_rate: "0.08",
  surplus_expected_stale_time_secs: 86_400,
  deficit_annualized_cost_rate: "0.25",
  deficit_expected_stale_time_secs: 259_200,
  out_of_band_severity_multiplier: "4.0",
};

export function buildJussiGraphId(now = new Date()): string {
  return `usdc-usdt-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

export function buildJussiGraphEnvelope(graph: BuiltJussiGraph): { graph_id: string; payload: JussiPutGraphRequest } {
  return {
    graph_id: graph.graphId,
    payload: graph.payload,
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
    return 11 * 60 * 60;
  }
  return LATENCY_BY_FAMILY[family];
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

export function buildManagedNodeTemplates(
  inventoryConfig: InventoryConfig,
  hubChainId = HUB_CHAIN_ID
): ManagedNodeTemplate[] {
  const templates = new Map<string, ManagedNodeTemplate>();

  const addTemplate = (template: ManagedNodeTemplate) => {
    const nodeKey = canonicalNodeKey(template.chainId, template.tokenAddress);
    templates.set(nodeKey, template);
  };

  for (const logicalAsset of LOGICAL_ASSETS) {
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

export function materializeNodeDefinitions(
  templates: ManagedNodeTemplate[],
  cumulativeBalancesByLogicalAsset: Record<LogicalAsset, BigNumber>
): ManagedNodeContext[] {
  return templates.map((template) => {
    const nodeKey = canonicalNodeKey(template.chainId, template.tokenAddress);
    const definition = template.managed
      ? buildManagedNodeDefinition(template, cumulativeBalancesByLogicalAsset[template.logicalAsset])
      : buildNeutralNodeDefinition(template);

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
  const {
    logger,
    baseSigner,
    relayerConfig,
    rebalancerConfig,
    inventoryClient,
    rebalanceRoutes,
    rebalancerAdapters,
    now,
  } = params;

  const graphId = params.graphId ?? buildJussiGraphId(now);
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Starting Jussi graph build",
    graphId,
    hubChainId: relayerConfig.hubPoolChainId,
    rebalanceRouteCount: rebalanceRoutes.length,
  });
  const cumulativeBalancesByLogicalAsset = Object.fromEntries(
    LOGICAL_ASSETS.map((logicalAsset) => {
      const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[logicalAsset].addresses[relayerConfig.hubPoolChainId]);
      return [logicalAsset, inventoryClient.getCumulativeBalanceWithApproximateUpcomingRefunds(l1Token)];
    })
  ) as Record<LogicalAsset, BigNumber>;
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Resolved cumulative balances for logical assets",
    balances: Object.fromEntries(
      Object.entries(cumulativeBalancesByLogicalAsset).map(([logicalAsset, balance]) => [logicalAsset, balance.toString()])
    ),
  });

  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Building managed node templates",
  });
  const nodeTemplates = buildManagedNodeTemplates(relayerConfig.inventoryConfig, relayerConfig.hubPoolChainId).filter(
    (template) => !chainIsSvm(template.chainId)
  );
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Built managed node templates",
    nodeTemplateCount: nodeTemplates.length,
  });
  const nodeContexts = materializeNodeDefinitions(nodeTemplates, cumulativeBalancesByLogicalAsset);
  nodeContexts.forEach((node, index) => {
    logger.info({
      at: "buildGraph.buildJussiGraphDefinition",
      message: "Constructed node",
      nodeIndex: index + 1,
      nodeCount: nodeContexts.length,
      nodeKey: node.nodeKey,
      chainId: node.chainId,
      symbol: node.symbol,
      logicalAsset: node.logicalAsset,
      managed: node.managed,
      targetBalanceNative: node.definition.target_balance_native,
      minThresholdNative: node.definition.min_threshold_native,
      maxThresholdNative: node.definition.max_threshold_native,
    });
  });
  const nodesByKey = new Map(nodeContexts.map((node) => [node.nodeKey, node]));
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Building bridge edge candidates",
    nodeCount: nodeContexts.length,
  });
  const bridgeCandidates = await buildBridgeEdgeCandidates({
    logger,
    baseSigner,
    relayerConfig,
    nodeContexts,
  });
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Built bridge edge candidates",
    bridgeCandidateCount: bridgeCandidates.length,
  });
  const rebalanceCandidates = buildRebalanceEdgeCandidates(rebalanceRoutes, nodeContexts, nodesByKey);
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Built rebalancer edge candidates",
    rebalanceCandidateCount: rebalanceCandidates.length,
  });
  const allowedSwapCandidates = buildAllowedSwapEdgeCandidates(relayerConfig, nodeContexts);
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Built allowed swap edge candidates",
    allowedSwapCandidateCount: allowedSwapCandidates.length,
  });
  const edgeCandidates = dedupeGraphEdgeCandidates([...bridgeCandidates, ...rebalanceCandidates, ...allowedSwapCandidates]);
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Deduped graph edge candidates",
    rawCandidateCount: bridgeCandidates.length + rebalanceCandidates.length + allowedSwapCandidates.length,
    dedupedEdgeCandidateCount: edgeCandidates.length,
  });

  validateAllowedSwapCoverage(relayerConfig, nodeContexts, edgeCandidates);
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Validated allowed swap route coverage",
  });

  const pricingContext = new RuntimePricingContext(logger);
  const edges: JussiEdgeDefinition[] = [];
  for (let index = 0; index < edgeCandidates.length; index += 1) {
    const candidate = edgeCandidates[index];
    logger.info({
      at: "buildGraph.buildJussiGraphDefinition",
      message: "Constructing edge",
      edgeIndex: index + 1,
      edgeCount: edgeCandidates.length,
      family: candidate.family,
      adapterOrBridgeName: candidate.adapterOrBridgeName,
      fromNodeKey: candidate.from.nodeKey,
      toNodeKey: candidate.to.nodeKey,
    });
    const economics = await estimateEdgeEconomics(candidate, {
      logger,
      baseSigner,
      pricingContext,
      rebalancerConfig,
      rebalancerAdapters,
      cumulativeBalancesByLogicalAsset,
    });
    const edge = serializeEdgeDefinition(candidate, economics);
    logger.info({
      at: "buildGraph.buildJussiGraphDefinition",
      message: "Constructed edge",
      edgeIndex: index + 1,
      edgeCount: edgeCandidates.length,
      edgeId: edge.edge_id,
      fromNodeKey: edge.from_node_key,
      toNodeKey: edge.to_node_key,
      inputCapacityNative: edge.input_capacity_native,
      fixedCostUsd: edge.cost_usd.fixed_cost_usd,
      latencySeconds: edge.latency_seconds,
    });
    edges.push(edge);
  }
  logger.info({
    at: "buildGraph.buildJussiGraphDefinition",
    message: "Finished Jussi graph build",
    graphId,
    nodeCount: nodeContexts.length,
    edgeCount: edges.length,
  });

  return {
    graphId,
    payload: {
      pain_model: DEFAULT_PAIN_MODEL,
      nodes: nodeContexts.map((node) => node.definition),
      edges,
    },
  };
}

function buildManagedNodeDefinition(template: ManagedNodeTemplate, cumulativeBalance: BigNumber): JussiNodeDefinition {
  assert(isDefined(template.tokenConfig), `Managed node ${template.symbol} on ${template.chainId} is missing token config`);

  const hubDecimals = getTokenInfoFromSymbol(template.logicalAsset, HUB_CHAIN_ID).decimals;
  const converter = ConvertDecimals(hubDecimals, template.decimals);
  const targetBalanceHubDecimals = cumulativeBalance.mul(template.tokenConfig.targetPct).div(toBNWei(1));
  const minThresholdHubDecimals = cumulativeBalance.mul(template.tokenConfig.thresholdPct).div(toBNWei(1));
  const maxThresholdHubDecimals = targetBalanceHubDecimals.mul(template.tokenConfig.targetOverageBuffer).div(toBNWei(1));

  return {
    node_key: "",
    chain_id: template.chainId,
    token_address: template.tokenAddress,
    symbol: template.symbol,
    logical_asset: template.logicalAsset,
    decimals: template.decimals,
    target_balance_native: converter(targetBalanceHubDecimals).toString(),
    min_threshold_native: converter(minThresholdHubDecimals).toString(),
    max_threshold_native: converter(maxThresholdHubDecimals).toString(),
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
    target_balance_native: "0",
    min_threshold_native: "0",
    max_threshold_native: "0",
    shortage_cost_usd_per_unit_time: "0",
    surplus_cost_usd_per_unit_time: "0",
  };
}

async function buildBridgeEdgeCandidates(params: {
  logger: winston.Logger;
  baseSigner: Signer;
  relayerConfig: RelayerConfig;
  nodeContexts: ManagedNodeContext[];
}): Promise<GraphEdgeCandidate[]> {
  const { relayerConfig, nodeContexts } = params;
  const nodesByLogicalAssetChain = indexNodesByLogicalAssetAndChain(nodeContexts);
  const hubNodesByLogicalAsset = new Map<LogicalAsset, ManagedNodeContext>(
    LOGICAL_ASSETS.map((logicalAsset) => {
      const hubNode = nodeContexts.find((node) => node.logicalAsset === logicalAsset && node.chainId === HUB_CHAIN_ID);
      assert(isDefined(hubNode), `Missing hub node for ${logicalAsset}`);
      return [logicalAsset, hubNode];
    })
  );
  const candidates: GraphEdgeCandidate[] = [];

  for (const logicalAsset of LOGICAL_ASSETS) {
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
            chainId,
            logicalAsset,
            adapterOrBridgeName: inboundBridge.name,
            chainNodes,
            fromNode: hubNodesByLogicalAsset.get(logicalAsset),
          })
        );
      }

      const outboundBridge = CUSTOM_L2_BRIDGE[chainId]?.[l1Token] ?? CANONICAL_L2_BRIDGE[chainId];
      if (isDefined(outboundBridge)) {
        candidates.push(
          ...resolveOutboundBridgeCandidates({
            chainId,
            logicalAsset,
            adapterOrBridgeName: outboundBridge.name,
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
  logger: winston.Logger;
  baseSigner: Signer;
  relayerConfig: RelayerConfig;
  nodeContexts: ManagedNodeContext[];
}): Promise<RebalanceRoute[]> {
  const routes = new Map<string, RebalanceRoute>();
  const bridgeCandidates = await buildBridgeEdgeCandidates(params);

  bridgeCandidates.forEach((candidate) => {
    if (candidate.family !== "oft" || candidate.from.logicalAsset !== "USDT" || candidate.to.logicalAsset !== "USDT") {
      return;
    }

    const route: RebalanceRoute = {
      sourceChain: candidate.from.chainId,
      sourceToken: candidate.from.logicalAsset,
      destinationChain: candidate.to.chainId,
      destinationToken: candidate.to.logicalAsset,
      adapter: candidate.family,
    };

    routes.set(
      [route.sourceChain, route.sourceToken, route.destinationChain, route.destinationToken, route.adapter].join("|"),
      route
    );
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

function resolveInboundBridgeCandidates(params: {
  chainId: number;
  logicalAsset: LogicalAsset;
  adapterOrBridgeName: string;
  fromNode: ManagedNodeContext;
  chainNodes: ManagedNodeContext[];
}): GraphEdgeCandidate[] {
  const { chainId, logicalAsset, adapterOrBridgeName, fromNode, chainNodes } = params;
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[logicalAsset].addresses[HUB_CHAIN_ID]);
  const canonicalRemoteToken = getRemoteTokenForL1Token(l1Token, chainId, HUB_CHAIN_ID)?.toNative().toLowerCase();
  const bridgedRemoteToken = resolveOptionalTranslatedTokenAddress(l1Token, chainId);
  const nativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[chainId]?.toLowerCase();
  const splitterBridges = TOKEN_SPLITTER_BRIDGES[chainId]?.[l1Token.toNative()];

  return chainNodes.flatMap((node) => {
    let family: EdgeFamily | undefined;
    let effectiveBridgeName = adapterOrBridgeName;

    switch (adapterOrBridgeName) {
      case "UsdcTokenSplitterBridge":
        if (node.tokenAddress.toLowerCase() === nativeUsdc) {
          family = "cctp";
          effectiveBridgeName = "UsdcCCTPBridge";
        } else if (node.tokenAddress.toLowerCase() === canonicalRemoteToken) {
          family = "canonical";
          effectiveBridgeName = (CANONICAL_BRIDGE[chainId]?.name ?? "CanonicalBridge");
        }
        break;
      case "TokenSplitterBridge":
        if (splitterBridges?.[0] && node.tokenAddress.toLowerCase() === canonicalRemoteToken) {
          family = familyForBridgeName(splitterBridges[0].name);
          effectiveBridgeName = splitterBridges[0].name;
        } else if (splitterBridges?.[1]) {
          family = familyForBridgeName(splitterBridges[1].name);
          effectiveBridgeName = splitterBridges[1].name;
        }
        break;
      case "UsdcCCTPBridge":
        if (node.tokenAddress.toLowerCase() === nativeUsdc) {
          family = "cctp";
        }
        break;
      case "OFTBridge":
        if (node.tokenAddress.toLowerCase() === bridgedRemoteToken) {
          family = "oft";
        }
        break;
      case "BridgeApi":
        family = node.symbol === "pathUSD" ? "bridgeapi" : undefined;
        break;
      default:
        if (node.tokenAddress.toLowerCase() === canonicalRemoteToken) {
          family = familyForBridgeName(adapterOrBridgeName);
        }
        break;
    }

    return isDefined(family)
      ? [
          {
            family,
            adapterOrBridgeName,
            effectiveBridgeName,
            from: fromNode,
            to: node,
          } satisfies GraphEdgeCandidate,
        ]
      : [];
  });
}

function resolveOutboundBridgeCandidates(params: {
  chainId: number;
  logicalAsset: LogicalAsset;
  adapterOrBridgeName: string;
  toNode: ManagedNodeContext;
  chainNodes: ManagedNodeContext[];
}): GraphEdgeCandidate[] {
  const { chainId, logicalAsset, adapterOrBridgeName, toNode, chainNodes } = params;
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[logicalAsset].addresses[HUB_CHAIN_ID]);
  const canonicalRemoteToken = getRemoteTokenForL1Token(l1Token, chainId, HUB_CHAIN_ID)?.toNative().toLowerCase();
  const bridgedRemoteToken = resolveOptionalTranslatedTokenAddress(l1Token, chainId);
  const nativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[chainId]?.toLowerCase();

  return chainNodes.flatMap((node) => {
    let family: EdgeFamily | undefined;
    let effectiveBridgeName = adapterOrBridgeName;

    switch (adapterOrBridgeName) {
      case "UsdcCCTPBridge":
        if (node.tokenAddress.toLowerCase() === nativeUsdc) {
          family = "cctp";
          effectiveBridgeName = "UsdcCCTPBridge";
        }
        break;
      case "OFTL2Bridge":
        if (node.tokenAddress.toLowerCase() === bridgedRemoteToken) {
          family = "oft";
        }
        break;
      case "BinanceCEXBridge":
      case "BinanceCEXNativeBridge":
        if (node.tokenAddress.toLowerCase() === bridgedRemoteToken) {
          family = "binance_cex_bridge";
        }
        break;
      default:
        if (node.tokenAddress.toLowerCase() === canonicalRemoteToken || node.tokenAddress.toLowerCase() === nativeUsdc) {
          family = familyForBridgeName(adapterOrBridgeName);
        }
        break;
    }

    return isDefined(family)
      ? [
          {
            family,
            adapterOrBridgeName,
            effectiveBridgeName,
            from: node,
            to: toNode,
          } satisfies GraphEdgeCandidate,
        ]
      : [];
  });
}

function buildRebalanceEdgeCandidates(
  rebalanceRoutes: RebalanceRoute[],
  nodeContexts: ManagedNodeContext[],
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
    return [
      {
        family: route.adapter === "cctp" ? "cctp" : route.adapter === "oft" ? "oft" : (route.adapter as EdgeFamily),
        adapterOrBridgeName: route.adapter,
        from,
        to,
        rebalanceRoute: route,
      } satisfies GraphEdgeCandidate,
    ];
  });
}

export function buildAllowedSwapEdgeCandidates(
  relayerConfig: RelayerConfig,
  nodeContexts: ManagedNodeContext[]
): GraphEdgeCandidate[] {
  const nodesByIdentity = new Map(nodeContexts.map((node) => [`${node.chainId}:${node.tokenAddress.toLowerCase()}`, node]));
  const candidates: GraphEdgeCandidate[] = [];

  for (const swapRoute of relayerConfig.inventoryConfig.allowedSwapRoutes ?? []) {
    const fromTokenAddress = resolveSwapRouteTokenAddress(swapRoute.fromToken);
    const toTokenAddress = resolveSwapRouteTokenAddress(swapRoute.toToken);
    if (!isDefined(fromTokenAddress) || !isDefined(toTokenAddress)) {
      continue;
    }
    const fromChainId = resolveSwapRouteChainId(swapRoute.fromChain, fromTokenAddress, nodeContexts);
    const toChainId = resolveSwapRouteChainId(swapRoute.toChain, toTokenAddress, nodeContexts);
    if (!isDefined(fromChainId) || !isDefined(toChainId)) {
      continue;
    }
    const from = nodesByIdentity.get(`${fromChainId}:${fromTokenAddress.toLowerCase()}`);
    const to = nodesByIdentity.get(`${toChainId}:${toTokenAddress.toLowerCase()}`);
    if (!isDefined(from) || !isDefined(to)) {
      continue;
    }
    if (!isBridgeApiSwapCandidate(from, to)) {
      continue;
    }

    candidates.push({
      family: "bridgeapi",
      adapterOrBridgeName: "BridgeApi",
      effectiveBridgeName: "BridgeApi",
      from,
      to,
    });
  }

  return candidates;
}

function validateAllowedSwapCoverage(
  relayerConfig: RelayerConfig,
  nodeContexts: ManagedNodeContext[],
  edgeCandidates: GraphEdgeCandidate[]
): void {
  const edgeSet = new Set(edgeCandidates.map((edge) => `${edge.from.nodeKey}->${edge.to.nodeKey}`));
  const nodesByIdentity = new Map(nodeContexts.map((node) => [`${node.chainId}:${node.tokenAddress.toLowerCase()}`, node]));

  for (const swapRoute of relayerConfig.inventoryConfig.allowedSwapRoutes ?? []) {
    const fromTokenAddress = resolveSwapRouteTokenAddress(swapRoute.fromToken);
    const toTokenAddress = resolveSwapRouteTokenAddress(swapRoute.toToken);
    if (!isDefined(fromTokenAddress) || !isDefined(toTokenAddress)) {
      continue;
    }
    const fromChainId = resolveSwapRouteChainId(swapRoute.fromChain, fromTokenAddress, nodeContexts);
    const toChainId = resolveSwapRouteChainId(swapRoute.toChain, toTokenAddress, nodeContexts);
    if (!isDefined(fromChainId) || !isDefined(toChainId)) {
      continue;
    }
    const from = nodesByIdentity.get(`${fromChainId}:${fromTokenAddress.toLowerCase()}`);
    const to = nodesByIdentity.get(`${toChainId}:${toTokenAddress.toLowerCase()}`);
    if (!isDefined(from) || !isDefined(to)) {
      continue;
    }
    if (!isBridgeApiSwapCandidate(from, to)) {
      continue;
    }
    assert(edgeSet.has(`${from.nodeKey}->${to.nodeKey}`), `Missing graph edge for allowed swap route ${from.nodeKey} -> ${to.nodeKey}`);
  }
}

export function dedupeGraphEdgeCandidates(candidates: GraphEdgeCandidate[]): GraphEdgeCandidate[] {
  const deduped = new Map<string, GraphEdgeCandidate>();
  for (const candidate of candidates) {
    const key = [candidate.family, candidate.adapterOrBridgeName, candidate.from.nodeKey, candidate.to.nodeKey].join("|");
    deduped.set(key, candidate);
  }
  return Array.from(deduped.values());
}

function serializeEdgeDefinition(candidate: GraphEdgeCandidate, economics: EdgeEconomics): JussiEdgeDefinition {
  const [numerator, denominator] = reduceRate(economics.expectedOutputNative, economics.inputCapacityNative);
  return {
    edge_id: [
      candidate.family,
      candidate.adapterOrBridgeName,
      candidate.from.chainId,
      candidate.from.symbol,
      candidate.to.chainId,
      candidate.to.symbol,
    ].join(":"),
    from_node_key: candidate.from.nodeKey,
    to_node_key: candidate.to.nodeKey,
    input_capacity_native: economics.inputCapacityNative.toString(),
    output: {
      segments: [
        {
          up_to_input_native: economics.inputCapacityNative.toString(),
          marginal_output_rate: {
            numerator: numerator.toString(),
            denominator: denominator.toString(),
          },
        },
      ],
    },
    cost_usd: {
      fixed_cost_usd: formatDecimal(economics.additiveCostUsd),
      segments: [
        {
          up_to_input_native: economics.inputCapacityNative.toString(),
          marginal_cost_per_unit_usd: "0",
        },
      ],
    },
    latency_seconds: economics.latencySeconds,
  };
}

async function estimateEdgeEconomics(
  candidate: GraphEdgeCandidate,
  params: {
    logger: winston.Logger;
    baseSigner: Signer;
    pricingContext: RuntimePricingContext;
    rebalancerConfig: RebalancerConfig;
    rebalancerAdapters: Record<string, RebalancerAdapter>;
    cumulativeBalancesByLogicalAsset: Record<LogicalAsset, BigNumber>;
  },
  attempt = 0
): Promise<EdgeEconomics> {
  try {
    const referenceInputNative = resolveReferenceInput(
      candidate,
      params.rebalancerConfig,
      params.cumulativeBalancesByLogicalAsset
    );
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
                ? await estimateBinanceCexBridgeBreakdown(candidate, referenceInputNative, params)
                : candidate.family === "bridgeapi"
                  ? await estimateBridgeApiBreakdown(candidate, referenceInputNative, params)
                  : candidate.family === "hyperlane"
                    ? await estimateQuotedBridgeBreakdown(candidate, referenceInputNative, params, "hyperlane")
                    : await estimateQuotedBridgeBreakdown(candidate, referenceInputNative, params, "canonical");

    const outputInDestinationNative = ConvertDecimals(candidate.from.decimals, candidate.to.decimals)(
      referenceInputNative.sub(minBigNumber(breakdown.tokenLossSourceNative, referenceInputNative))
    );

    return {
      inputCapacityNative: referenceInputNative,
      expectedOutputNative: outputInDestinationNative,
      additiveCostUsd: breakdown.additiveCostUsd,
      latencySeconds: breakdown.latencySeconds,
    };
  } catch (error) {
    const errorText = error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error);
    if (
      attempt >= 3 ||
      !TRANSIENT_EDGE_PRICING_ERROR_PATTERNS.some((pattern) => errorText.includes(pattern))
    ) {
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

function resolveReferenceInput(
  candidate: GraphEdgeCandidate,
  rebalancerConfig: RebalancerConfig,
  cumulativeBalancesByLogicalAsset: Record<LogicalAsset, BigNumber>
): BigNumber {
  if (candidate.rebalanceRoute) {
    const configured = rebalancerConfig.maxAmountsToTransfer[candidate.rebalanceRoute.sourceToken]?.[candidate.rebalanceRoute.sourceChain];
    if (isDefined(configured)) {
      return configured;
    }
  }

  if (candidate.family === "cctp") {
    return CCTP_MAX_SEND_AMOUNT;
  }

  const hubDecimals = getTokenInfoFromSymbol(candidate.from.logicalAsset, HUB_CHAIN_ID).decimals;
  const converter = ConvertDecimals(hubDecimals, candidate.from.decimals);
  const derived = converter(cumulativeBalancesByLogicalAsset[candidate.from.logicalAsset]);
  return derived.gt(bnZero) ? derived : toBN(10).pow(candidate.from.decimals);
}

async function estimateCctpBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: {
    baseSigner: Signer;
    pricingContext: RuntimePricingContext;
    rebalancerAdapters: Record<string, RebalancerAdapter>;
  }
): Promise<CostBreakdown> {
  return estimateQuotedBridgeBreakdown(candidate, amount, params, "cctp");
}

async function estimateOftBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: {
    baseSigner: Signer;
    pricingContext: RuntimePricingContext;
    rebalancerAdapters: Record<string, RebalancerAdapter>;
  }
): Promise<CostBreakdown> {
  if (candidate.from.logicalAsset !== "USDT" || candidate.to.logicalAsset !== "USDT") {
    return estimateQuotedBridgeBreakdown(candidate, amount, params, "oft");
  }
  const oftAdapter = params.rebalancerAdapters.oft as OftAdapter;
  const route: RebalanceRoute = {
    sourceChain: candidate.from.chainId,
    destinationChain: candidate.to.chainId,
    sourceToken: "USDT",
    destinationToken: "USDT",
    adapter: "oft",
  };
  const oftQuote = await (oftAdapter as any)._getOftQuoteSend(route.sourceChain, route.destinationChain, amount);
  const tokenLossSourceNative = amount.sub(BigNumber.from(oftQuote.sendParamStruct.minAmountLD.toString()));
  const additiveSourceNative = await oftAdapter.getEstimatedCost(route, amount);
  const additiveCostUsd = Math.max(
    parseFloat(formatUnits(additiveSourceNative, candidate.from.decimals)) * STABLECOIN_PRICE_USD[candidate.from.logicalAsset],
    await params.pricingContext.deriveGasFloorUsd(candidate.family, candidate.from.chainId)
  );
  return {
    tokenLossSourceNative,
    additiveCostUsd,
    latencySeconds: resolveBridgeLatencySeconds("oft", candidate.from.chainId, candidate.from.logicalAsset),
  };
}

async function estimateBridgeRouteBreakdown(
  token: LogicalAsset,
  sourceChain: number,
  destinationChain: number,
  amount: BigNumber,
  params: {
    baseSigner: Signer;
    pricingContext: RuntimePricingContext;
    rebalancerAdapters: Record<string, RebalancerAdapter>;
  }
): Promise<CostBreakdown> {
  if (token === "USDC") {
    const sourceTokenInfo = getTokenInfoFromSymbol("USDC", sourceChain);
    const destinationTokenInfo = getTokenInfoFromSymbol("USDC", destinationChain);
    const candidate = {
      family: "cctp" as const,
      adapterOrBridgeName: "cctp",
      from: {
        chainId: sourceChain,
        tokenAddress: sourceTokenInfo.address.toNative(),
        symbol: sourceTokenInfo.symbol,
        nodeKey: `evm:${sourceChain}:${sourceTokenInfo.address.toNative().toLowerCase()}`,
        decimals: sourceTokenInfo.decimals,
        logicalAsset: "USDC",
      },
      to: {
        chainId: destinationChain,
        tokenAddress: destinationTokenInfo.address.toNative(),
        symbol: destinationTokenInfo.symbol,
        nodeKey: `evm:${destinationChain}:${destinationTokenInfo.address.toNative().toLowerCase()}`,
        decimals: destinationTokenInfo.decimals,
        logicalAsset: "USDC",
      },
    } as GraphEdgeCandidate;
    return estimateCctpBreakdown(candidate, amount, params);
  }
  const sourceTokenInfo = getTokenInfoFromSymbol("USDT", sourceChain);
  const destinationTokenInfo = getTokenInfoFromSymbol("USDT", destinationChain);
  const candidate = {
    family: "oft" as const,
    adapterOrBridgeName: "oft",
    from: {
      chainId: sourceChain,
      tokenAddress: sourceTokenInfo.address.toNative(),
      symbol: sourceTokenInfo.symbol,
      nodeKey: `evm:${sourceChain}:${sourceTokenInfo.address.toNative().toLowerCase()}`,
      decimals: sourceTokenInfo.decimals,
      logicalAsset: "USDT",
    },
    to: {
      chainId: destinationChain,
      tokenAddress: destinationTokenInfo.address.toNative(),
      symbol: destinationTokenInfo.symbol,
      nodeKey: `evm:${destinationChain}:${destinationTokenInfo.address.toNative().toLowerCase()}`,
      decimals: destinationTokenInfo.decimals,
      logicalAsset: "USDT",
    },
  } as GraphEdgeCandidate;
  return estimateOftBreakdown(candidate, amount, params);
}

async function estimateBinanceSwapBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: {
    logger: winston.Logger;
    baseSigner: Signer;
    pricingContext: RuntimePricingContext;
    rebalancerAdapters: Record<string, RebalancerAdapter>;
  }
): Promise<CostBreakdown> {
  assert(isDefined(candidate.rebalanceRoute), "Binance swap edge is missing rebalance route");
  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  const adapterAny = adapter as any;
  const { sourceToken, destinationToken, sourceChain, destinationChain } = candidate.rebalanceRoute;
  const allInSourceNative = await adapter.getEstimatedCost(candidate.rebalanceRoute, amount, false);
  const spotMarketMeta = adapterAny._getSpotMarketMetaForRoute(sourceToken, destinationToken);
  const tradeFeePct = (await adapterAny._getTradeFees()).find((fee: { symbol: string }) => fee.symbol === spotMarketMeta.symbol)
    .takerCommission;
  const tradeFee = toBNWei(tradeFeePct, 18).mul(amount).div(toBNWei(100, 18));
  const destinationCoin = await adapterAny._getAccountCoins(destinationToken);
  const destinationEntrypointNetwork = await adapterAny._getEntrypointNetwork(destinationChain, destinationToken);
  const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationEntrypointNetwork);
  const withdrawNetwork = BINANCE_NETWORKS[destinationEntrypointNetwork];
  const withdrawNetworkConfig =
    destinationCoin.networkList.find((network: { name: string }) => network.name === withdrawNetwork) ??
    destinationCoin.networkList[0];
  const withdrawFee = toBNWei(withdrawNetworkConfig.withdrawFee, destinationTokenInfo.decimals);
  const amountConverter = adapterAny._getAmountConverter(
    destinationEntrypointNetwork,
    destinationTokenInfo.address,
    sourceChain,
    getTokenInfoFromSymbol(sourceToken, sourceChain).address
  );
  const withdrawFeeConverted = amountConverter(withdrawFee);
  const { latestPrice } = await adapterAny._getLatestPrice(sourceToken, destinationToken, sourceChain, amount);
  const spreadPct = spotMarketMeta.isBuy ? latestPrice - 1 : 1 - latestPrice;
  const spreadFee = toBNWei(spreadPct.toFixed(18), 18).mul(amount).div(toBNWei(1, 18));

  let tokenLossSourceNative = tradeFee.add(withdrawFeeConverted).add(spreadFee);
  let additiveCostUsd = await params.pricingContext.deriveGasFloorUsd(candidate.family, sourceChain);
  let sourceBridgeLatencySeconds = 0;
  let destinationBridgeLatencySeconds = 0;

  const sourceEntrypointNetwork = await adapterAny._getEntrypointNetwork(sourceChain, sourceToken);
  if (sourceEntrypointNetwork !== sourceChain) {
    const bridgeBreakdown = await estimateBridgeRouteBreakdown(
      sourceToken as LogicalAsset,
      sourceChain,
      sourceEntrypointNetwork,
      amount,
      params
    );
    tokenLossSourceNative = tokenLossSourceNative.add(bridgeBreakdown.tokenLossSourceNative);
    additiveCostUsd += bridgeBreakdown.additiveCostUsd;
    sourceBridgeLatencySeconds = bridgeBreakdown.latencySeconds;
  }

  if (destinationEntrypointNetwork !== destinationChain) {
    const bridgeBreakdown = await estimateBridgeRouteBreakdown(
      destinationToken as LogicalAsset,
      destinationEntrypointNetwork,
      destinationChain,
      amount,
      params
    );
    tokenLossSourceNative = tokenLossSourceNative.add(
      ConvertDecimals(getTokenInfoFromSymbol(destinationToken, destinationEntrypointNetwork).decimals, candidate.from.decimals)(
        bridgeBreakdown.tokenLossSourceNative
      )
    );
    additiveCostUsd += bridgeBreakdown.additiveCostUsd;
    destinationBridgeLatencySeconds = bridgeBreakdown.latencySeconds;
  }

  const requiresSlowOftLeg =
    sourceChain === CHAIN_IDs.HYPEREVM && sourceToken === "USDT" && sourceEntrypointNetwork !== CHAIN_IDs.HYPEREVM;
  if (requiresSlowOftLeg) {
    const opportunityPct = (adapter as any)._getOpportunityCostOfCapitalPctForRebalanceTime(11 * 60 * 60 * 1000);
    additiveCostUsd += parseFloat(formatUnits(toBNWei(opportunityPct, 18).mul(amount).div(toBNWei(100, 18)), candidate.from.decimals));
  }

  const reconstructedSourceUsd = parseFloat(formatUnits(tokenLossSourceNative, candidate.from.decimals)) + additiveCostUsd;
  const allInSourceUsd = parseFloat(formatUnits(allInSourceNative, candidate.from.decimals));
  if (Math.abs(reconstructedSourceUsd - allInSourceUsd) > 0.25) {
    params.logger.warn({
      at: "buildGraph.estimateBinanceSwapBreakdown",
      message: "Binance edge decomposition differs materially from adapter all-in estimate",
      from: candidate.from.nodeKey,
      to: candidate.to.nodeKey,
      reconstructedSourceUsd,
      allInSourceUsd,
    });
  }

  return {
    tokenLossSourceNative,
    additiveCostUsd,
    latencySeconds: resolveExchangeLatencySeconds({
      family: "binance",
      sourceBridgeLatencySeconds,
      destinationBridgeLatencySeconds,
    }),
  };
}

async function estimateHyperliquidSwapBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: {
    logger: winston.Logger;
    baseSigner: Signer;
    pricingContext: RuntimePricingContext;
    rebalancerAdapters: Record<string, RebalancerAdapter>;
  }
): Promise<CostBreakdown> {
  assert(isDefined(candidate.rebalanceRoute), "Hyperliquid swap edge is missing rebalance route");
  const adapter = params.rebalancerAdapters.hyperliquid as HyperliquidStablecoinSwapAdapter;
  const adapterAny = adapter as any;
  const { sourceToken, destinationToken, sourceChain, destinationChain } = candidate.rebalanceRoute;
  const allInSourceNative = await adapter.getEstimatedCost(candidate.rebalanceRoute, amount, false);
  const spotMarketMeta = adapterAny._getSpotMarketMetaForRoute(sourceToken, destinationToken);
  const { px } = await adapterAny._getLatestPrice(sourceToken, destinationToken, destinationChain, amount, 1.0);
  const latestPrice = Number(px);
  const spreadPct = spotMarketMeta.isBuy ? latestPrice - 1 : 1 - latestPrice;
  const spreadFee = toBNWei(spreadPct.toFixed(18), 18).mul(amount).div(toBNWei(1, 18));
  const takerFeePct = await adapterAny._getUserTakerFeePct();
  const takerFee = takerFeePct.mul(amount).div(toBNWei(100, 18));

  let tokenLossSourceNative = spreadFee.add(takerFee);
  let additiveCostUsd = await params.pricingContext.deriveGasFloorUsd(candidate.family, sourceChain);
  let sourceBridgeLatencySeconds = 0;
  let destinationBridgeLatencySeconds = 0;

  if (sourceChain !== CHAIN_IDs.HYPEREVM) {
    const bridgeBreakdown = await estimateBridgeRouteBreakdown(
      sourceToken as LogicalAsset,
      sourceChain,
      CHAIN_IDs.HYPEREVM,
      amount,
      params
    );
    tokenLossSourceNative = tokenLossSourceNative.add(bridgeBreakdown.tokenLossSourceNative);
    additiveCostUsd += bridgeBreakdown.additiveCostUsd;
    sourceBridgeLatencySeconds = bridgeBreakdown.latencySeconds;
  }

  if (destinationChain !== CHAIN_IDs.HYPEREVM) {
    const bridgeBreakdown = await estimateBridgeRouteBreakdown(
      destinationToken as LogicalAsset,
      CHAIN_IDs.HYPEREVM,
      destinationChain,
      amount,
      params
    );
    tokenLossSourceNative = tokenLossSourceNative.add(
      ConvertDecimals(getTokenInfoFromSymbol(destinationToken, destinationChain).decimals, candidate.from.decimals)(
        bridgeBreakdown.tokenLossSourceNative
      )
    );
    additiveCostUsd += bridgeBreakdown.additiveCostUsd;
    destinationBridgeLatencySeconds = bridgeBreakdown.latencySeconds;
  }

  const requiresSlowOftLeg = destinationChain !== CHAIN_IDs.HYPEREVM && destinationToken === "USDT";
  if (requiresSlowOftLeg) {
    const opportunityPct = (adapter as any)._getOpportunityCostOfCapitalPctForRebalanceTime(11 * 60 * 60 * 1000);
    additiveCostUsd += parseFloat(formatUnits(toBNWei(opportunityPct, 18).mul(amount).div(toBNWei(100, 18)), candidate.from.decimals));
  }

  const reconstructedSourceUsd = parseFloat(formatUnits(tokenLossSourceNative, candidate.from.decimals)) + additiveCostUsd;
  const allInSourceUsd = parseFloat(formatUnits(allInSourceNative, candidate.from.decimals));
  if (Math.abs(reconstructedSourceUsd - allInSourceUsd) > 0.25) {
    params.logger.warn({
      at: "buildGraph.estimateHyperliquidSwapBreakdown",
      message: "Hyperliquid edge decomposition differs materially from adapter all-in estimate",
      from: candidate.from.nodeKey,
      to: candidate.to.nodeKey,
      reconstructedSourceUsd,
      allInSourceUsd,
    });
  }

  return {
    tokenLossSourceNative,
    additiveCostUsd,
    latencySeconds: resolveExchangeLatencySeconds({
      family: "hyperliquid",
      sourceBridgeLatencySeconds,
      destinationBridgeLatencySeconds,
    }),
  };
}

async function estimateBinanceCexBridgeBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: {
    pricingContext: RuntimePricingContext;
    rebalancerAdapters: Record<string, RebalancerAdapter>;
  }
): Promise<CostBreakdown> {
  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  const adapterAny = adapter as any;
  const tokenSymbol = candidate.from.logicalAsset;
  const network = BINANCE_NETWORKS[candidate.to.chainId] ?? BINANCE_NETWORKS[candidate.from.chainId] ?? BINANCE_NETWORKS[HUB_CHAIN_ID];
  const coin = await adapterAny._getAccountCoins(tokenSymbol);
  const withdrawFeeConfig = coin.networkList.find((entry) => entry.name === network);
  assert(isDefined(withdrawFeeConfig), `Withdraw fee config not found for ${tokenSymbol} on Binance network ${network}`);

  return {
    tokenLossSourceNative: toBNWei(withdrawFeeConfig.withdrawFee, candidate.from.decimals),
    additiveCostUsd: await params.pricingContext.deriveGasFloorUsd(candidate.family, candidate.from.chainId),
    latencySeconds: LATENCY_BY_FAMILY.binance_cex_bridge,
  };
}

async function estimateBridgeApiBreakdown(
  candidate: GraphEdgeCandidate,
  _amount: BigNumber,
  params: {
    pricingContext: RuntimePricingContext;
  }
): Promise<CostBreakdown> {
  return {
    tokenLossSourceNative: bnZero,
    additiveCostUsd: await params.pricingContext.deriveGasFloorUsd(candidate.family, candidate.from.chainId),
    latencySeconds: LATENCY_BY_FAMILY.bridgeapi,
  };
}

async function estimateQuotedBridgeBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: {
    baseSigner: Signer;
    pricingContext: RuntimePricingContext;
  },
  family: EdgeFamily
): Promise<CostBreakdown> {
  const quotedFeeUsd = await quoteNativeBridgeFeeUsd(candidate, amount, params);
  return {
    tokenLossSourceNative: bnZero,
    additiveCostUsd: Math.max(quotedFeeUsd, await params.pricingContext.deriveGasFloorUsd(family, candidate.from.chainId)),
    latencySeconds: LATENCY_BY_FAMILY[family],
  };
}

async function quoteNativeBridgeFeeUsd(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: {
    baseSigner: Signer;
    pricingContext: RuntimePricingContext;
  }
): Promise<number> {
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[candidate.from.logicalAsset].addresses[HUB_CHAIN_ID]);
  if (candidate.to.chainId === HUB_CHAIN_ID) {
    const constructor = CUSTOM_L2_BRIDGE[candidate.from.chainId]?.[l1Token.toNative()] ?? CANONICAL_L2_BRIDGE[candidate.from.chainId];
    if (!isDefined(constructor)) {
      return 0;
    }
    const l2Provider = await getProvider(candidate.from.chainId);
    const l2SignerOrProvider = chainIsSvm(candidate.from.chainId)
      ? l2Provider
      : params.baseSigner.connect(l2Provider);
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
      totalUsd += await params.pricingContext.nativeValueToUsd(txn.value ?? bnZero, txn.chainId ?? candidate.from.chainId);
    }
    return totalUsd;
  }

  const constructor = CUSTOM_BRIDGE[candidate.to.chainId]?.[l1Token.toNative()] ?? CANONICAL_BRIDGE[candidate.to.chainId];
  if (!isDefined(constructor)) {
    return 0;
  }
  const l1Signer = params.baseSigner.connect(await getProvider(HUB_CHAIN_ID));
  const l2Provider = await getProvider(candidate.to.chainId);
  const bridge = new constructor(candidate.to.chainId, HUB_CHAIN_ID, l1Signer, l2Provider, l1Token, params.pricingContext.logger);
  const txn = await bridge.constructL1ToL2Txn(
    EvmAddress.from(await params.baseSigner.getAddress()),
    l1Token,
    toAddressType(candidate.to.tokenAddress, candidate.to.chainId),
    amount
  );
  return params.pricingContext.nativeValueToUsd(txn.value ?? bnZero, HUB_CHAIN_ID);
}

function resolveSwapRouteChainId(chainField: number | "ALL", tokenAddress: string, nodeContexts: ManagedNodeContext[]): number | undefined {
  if (chainField !== "ALL") {
    return chainField;
  }
  return nodeContexts.find((node) => node.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())?.chainId;
}

function resolveSwapRouteTokenAddress(token: string | { toNative: () => string }): string | undefined {
  if (typeof token === "string") {
    return token;
  }
  return token?.toNative?.();
}

function isBridgeApiSwapCandidate(from: ManagedNodeContext, to: ManagedNodeContext): boolean {
  return (
    (from.logicalAsset === "USDC" && to.symbol === "pathUSD") ||
    (from.symbol === "pathUSD" && to.logicalAsset === "USDC")
  );
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

function reduceRate(numerator: BigNumber, denominator: BigNumber): [bigint, bigint] {
  const initialNumerator = BigInt(numerator.toString());
  const initialDenominator = BigInt(denominator.toString());
  if (initialNumerator === 0n) {
    return [0n, 1n];
  }
  const divisor = greatestCommonDivisor(initialNumerator, initialDenominator);
  return [initialNumerator / divisor, initialDenominator / divisor];
}

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
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
  private readonly gasPriceCache = new Map<number, BigNumber>();
  private readonly nativePriceCache = new Map<number, number>();

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

  private async getGasPrice(chainId: number): Promise<BigNumber> {
    const cached = this.gasPriceCache.get(chainId);
    if (isDefined(cached)) {
      return cached;
    }
    try {
      const provider = await getProvider(chainId);
      const feeData = await getOracleGasPrice(provider, 1, 1);
      const resolved = feeData.maxFeePerGas ?? feeData.maxPriorityFeePerGas;
      assert(isDefined(resolved) && resolved.gt(bnZero), `Gas price oracle returned no usable gas price for ${chainId}`);
      this.gasPriceCache.set(chainId, resolved);
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
  }

  private async getNativeTokenPriceUsd(chainId: number): Promise<number> {
    const cached = this.nativePriceCache.get(chainId);
    if (isDefined(cached)) {
      return cached;
    }
    try {
      const nativeTokenInfo = getNativeTokenInfoForChain(chainId, HUB_CHAIN_ID);
      const price = await this.priceClient.getPriceByAddress(nativeTokenInfo.address);
      const resolved = Number(price.price);
      this.nativePriceCache.set(chainId, resolved);
      return resolved;
    } catch (error) {
      this.logger.warn({
        at: "buildGraph.RuntimePricingContext.getNativeTokenPriceUsd",
        message: "Failed to query native token USD price, using $1 fallback",
        chainId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.nativePriceCache.set(chainId, 1);
      return 1;
    }
  }
}
