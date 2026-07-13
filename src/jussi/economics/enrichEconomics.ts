import { BigNumber, EvmAddress, TOKEN_SYMBOLS_MAP, assert, chunk, isDefined, mapAsync } from "../../utils";
import {
  DEFAULT_ASSET_CLASSES,
  DEFAULT_CROSS_ASSET_VOLATILITY,
  DEFAULT_CROSS_ASSET_VOLATILITY_SIGMA_MULTIPLIER,
  DEFAULT_EXPECTED_FILL_LATENCY_SECONDS,
  DEFAULT_LATENCY_ANNUALIZED_COST_RATE,
  DEFAULT_PAIN_MODEL,
  EDGE_BUILD_BATCH_SIZE,
  JUSSI_LOGICAL_ASSETS,
} from "../constants";
import { buildJussiGraphId } from "../serialize";
import type {
  BuildGraphParams,
  BuiltJussiGraph,
  GraphEdgeCandidate,
  JussiEdgeDefinition,
  JussiGraphLiveDeps,
  LogicalAsset,
  PreparedGraphTopologyForBuild,
} from "../types";
import { buildTopology } from "../topology/buildTopology";
import { buildCumulativeBalancePainDefinitions } from "./pain";
import { RuntimePricingContext } from "./PricingContext";
import { estimateEdgeEconomics, serializeEdgeDefinition } from "./edgeCosts";
import { serializeEdgeClassDefinition } from "./rates";
import { resolveEdgeClassId } from "../topology/edges";

export async function buildJussiGraphDefinition(params: BuildGraphParams): Promise<BuiltJussiGraph> {
  const hubCtx = { hubPoolChainId: params.relayerConfig.hubPoolChainId };
  const topology = buildTopology({
    relayerConfig: params.relayerConfig,
    rebalanceRoutes: params.rebalanceRoutes,
    hubCtx,
  });
  return enrichPreparedTopology(
    {
      relayerConfig: params.relayerConfig,
      hubCtx,
      rebalanceRoutes: params.rebalanceRoutes,
      topology,
    },
    params
  );
}

export async function enrichPreparedTopology(
  prepared: PreparedGraphTopologyForBuild,
  params: JussiGraphLiveDeps
): Promise<BuiltJussiGraph> {
  const { logger, baseSigner, relayerAddress, inventoryClient, rebalancerAdapters, now } = params;
  const { relayerConfig, rebalanceRoutes, topology, hubCtx } = prepared;
  const { nodeContexts, edgeCandidates, logicalAssets, requiredNativePriceChains } = topology;

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

  logBuild("Using prepared graph topology", {
    nodeCount: nodeContexts.length,
    edgeCandidateCount: edgeCandidates.length,
    requiredNativePriceChains,
  });

  const pricingContext = new RuntimePricingContext(logger, hubCtx.hubPoolChainId);
  const edgePricingParams = {
    logger,
    baseSigner,
    relayerAddress,
    pricingContext,
    rebalancerAdapters,
    cumulativeBalancesByLogicalAsset,
  };
  logBuild("Resolved native asset price requirements", {
    nativePriceAliasChainIds: Object.values(logicalAssets)
      .flatMap((definition) => definition.native_price_alias_chain_ids ?? [])
      .map(Number)
      .sort((a, b) => a - b),
    requiredNativePriceChains,
  });
  const gasPriceDiagnostics = await pricingContext.describeGasPrices(nodeContexts.map((node) => node.chainId));
  logBuild("Resolved gas prices for graph chains", {
    gasPrices: gasPriceDiagnostics.map(({ chainId, gasPriceGwei, source }) => ({
      chainId,
      gasPriceGwei,
      source,
    })),
  });
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
        fixedCostNative: edge.cost.fixed_cost_native,
        latencySeconds: edge.latency_seconds,
      });
      return edge;
    });
    edges.push(...builtEdges);
  }
  logBuild("Finished Jussi graph build", { graphId, nodeCount: nodeContexts.length, edgeCount: edges.length });

  return {
    graphId,
    gasPriceDiagnostics,
    rate_limit_buckets: topology.rateLimitBuckets,
    payload: {
      asset_classes: DEFAULT_ASSET_CLASSES,
      default_cross_asset_volatility: DEFAULT_CROSS_ASSET_VOLATILITY,
      cross_asset_volatility_sigma_multiplier: DEFAULT_CROSS_ASSET_VOLATILITY_SIGMA_MULTIPLIER,
      expected_fill_latency_seconds: DEFAULT_EXPECTED_FILL_LATENCY_SECONDS,
      latency_annualized_cost_rate: DEFAULT_LATENCY_ANNUALIZED_COST_RATE,
      pain_model: DEFAULT_PAIN_MODEL,
      logical_assets: logicalAssets,
      cumulative_balance_pain: buildCumulativeBalancePainDefinitions(cumulativeBalancesByLogicalAsset),
      edge_classes: Array.from(edgeClassDefinitions.values()).sort((a, b) =>
        a.edge_class_id.localeCompare(b.edge_class_id)
      ),
      nodes: nodeContexts.map((node) => node.definition),
      edges,
    },
  };
}

export function runFullBuild(
  prepared: PreparedGraphTopologyForBuild,
  liveDeps: JussiGraphLiveDeps
): Promise<BuiltJussiGraph> {
  return enrichPreparedTopology(prepared, liveDeps);
}
