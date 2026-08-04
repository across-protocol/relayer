import { BigNumber, EvmAddress, TOKEN_SYMBOLS_MAP, chunk, mapAsync } from "../../utils";
import {
  DEFAULT_LATENCY_ANNUALIZED_COST_RATE,
  DEFAULT_PAIN_MODEL,
  EDGE_BUILD_BATCH_SIZE,
  JUSSI_LOGICAL_ASSETS,
} from "../constants";
import { buildJussiGraphId } from "../serialize";
import type {
  BuiltJussiGraph,
  JussiEdgeDefinition,
  JussiGraphLiveDeps,
  LogicalAsset,
  PreparedGraphTopology,
} from "../types";
import { buildCumulativeBalancePainDefinitions } from "./pain";
import { RuntimePricingContext } from "./PricingContext";
import { estimateEdgeEconomics, serializeEdgeDefinition } from "./edgeCosts";
import { serializeEdgeClassDefinition } from "./rates";
import { resolveEdgeClassId } from "../topology/edges";

export async function runFullBuild(
  prepared: PreparedGraphTopology,
  params: JussiGraphLiveDeps
): Promise<BuiltJussiGraph> {
  const { logger, baseSigner, inventoryClient, rebalancerAdapters, now } = params;
  const { relayerConfig, rebalanceRoutes, topology, hubCtx } = prepared;
  const { nodeContexts, edgeCandidates, logicalAssets, requiredNativePriceChains } = topology;

  const graphId = params.graphId ?? buildJussiGraphId(now);
  const logBuild = (message: string, extra: Record<string, unknown> = {}) =>
    logger.info({ at: "buildGraph.runFullBuild", message, ...extra });
  const debugBuild = (message: string, extra: Record<string, unknown> = {}) =>
    logger.debug({ at: "buildGraph.runFullBuild", message, ...extra });

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
    baseSigner,
    relayerAddress: inventoryClient.relayer.toNative(),
    pricingContext,
    rebalancerAdapters,
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
    gasPrices: gasPriceDiagnostics,
  });
  const edgeClassCandidates = Array.from(
    Map.groupBy(edgeCandidates, resolveEdgeClassId).values(),
    ([candidate]) => candidate
  );
  logBuild("Building edge classes", { edgeClassCount: edgeClassCandidates.length });
  const edgeClassDefinitions = (
    await mapAsync(edgeClassCandidates, (candidate) => serializeEdgeClassDefinition(candidate, edgePricingParams))
  ).sort((a, b) => a.edge_class_id.localeCompare(b.edge_class_id));
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
      const edge = serializeEdgeDefinition(candidate, economics, edgeClassId);
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
      asset_classes: { ETH: ["WETH"], USD_STABLE: ["USDC", "USDT"] },
      default_cross_asset_volatility: "0.650000",
      cross_asset_volatility_sigma_multiplier: "2.000000",
      expected_fill_latency_seconds: 5,
      latency_annualized_cost_rate: DEFAULT_LATENCY_ANNUALIZED_COST_RATE,
      pain_model: DEFAULT_PAIN_MODEL,
      logical_assets: logicalAssets,
      cumulative_balance_pain: buildCumulativeBalancePainDefinitions(cumulativeBalancesByLogicalAsset),
      edge_classes: edgeClassDefinitions,
      nodes: nodeContexts.map((node) => node.definition),
      edges,
    },
  };
}
