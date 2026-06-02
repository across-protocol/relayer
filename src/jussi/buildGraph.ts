import type { BuildGraphParams, BuiltJussiGraph, JussiGraphBundleJson, JussiGraphEnvelope } from "./types";
import { buildJussiGraphBundleJson, buildJussiGraphEnvelope, bundleHash } from "./serialize";
import { buildJussiGraphDefinition } from "./economics/enrichEconomics";

export type JussiGraphUploadBundle = {
  graphId: string;
  graph: BuiltJussiGraph;
  bundle: JussiGraphBundleJson;
  envelope: JussiGraphEnvelope;
  bundleHash: string;
};

/**
 * Public client entrypoint for building a Jussi graph bundle ready for PUT /graph_bundles/{graphId}.
 */
export async function buildJussiGraphUploadBundle(params: BuildGraphParams): Promise<JussiGraphUploadBundle> {
  const graph = await buildJussiGraphDefinition(params);
  const bundle = buildJussiGraphBundleJson(graph);
  return {
    graphId: graph.graphId,
    graph,
    bundle,
    envelope: buildJussiGraphEnvelope(graph),
    bundleHash: bundleHash(bundle),
  };
}

export * from "./types";
export * from "./constants";
export {
  buildJussiGraphBundleJson,
  buildJussiGraphEnvelope,
  buildJussiGraphId,
  buildJussiGraphJson,
  buildJussiRateLimitBucketsJson,
  bundleHash,
  stableJsonStringify,
} from "./serialize";
export { prepareGraphTopology } from "./prepareGraphTopology";
export { buildTopology } from "./topology/buildTopology";
export { buildJussiTopologyArtifact } from "./topology/artifact";
export {
  buildLogicalAssetDefinitions,
  resolveNativePriceAliasLogicalAsset,
  resolveRequiredNativePriceChains,
} from "./topology/logicalAssets";
export { buildManagedNodeTemplates, canonicalNodeKey, materializeNodeDefinitions } from "./topology/nodes";
export {
  buildBridgeAdapterRoutes,
  buildBridgeEdgeCandidates,
  buildRebalanceEdgeCandidates,
  dedupeGraphEdgeCandidates,
  resolveEdgeClassId,
  resolveOptionalTranslatedTokenAddress,
  resolveRateLimitBucketId,
  resolveSerializedEdgeId,
  resolveSerializedEdgeIdentity,
} from "./topology/edges";
export {
  LATENCY_BY_FAMILY,
  resolveBridgeLatencySeconds,
  resolveExchangeLatencySeconds,
  resolveGraphBridgeLatencySeconds,
} from "./topology/latency";
export { buildCumulativeBalancePainDefinitions } from "./economics/pain";
export { RuntimePricingContext } from "./economics/PricingContext";
export { enrichPreparedTopology, runFullBuild, buildJussiGraphDefinition } from "./economics/enrichEconomics";
export { quoteOftRouteTransfer, resolveOftQuoteExtraOptions, resolveOftQuoteSendFeeAsset } from "./economics/quotes";
