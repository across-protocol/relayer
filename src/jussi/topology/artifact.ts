import { canonicalizeJson } from "../serialize";
import type { GraphEdgeCandidate, JussiTopologyArtifactJson, PreparedGraphTopology } from "../types";
import { resolveEdgeClassId, resolveRateLimitBucketId, resolveSerializedEdgeId } from "./edges";

type SerializedRebalanceRoute = NonNullable<JussiTopologyArtifactJson["edge_candidates"][number]["rebalance_route"]>;

export function buildJussiTopologyArtifact(prepared: PreparedGraphTopology): JussiTopologyArtifactJson {
  const { topology } = prepared;
  return canonicalizeJson({
    hub_pool_chain_id: prepared.hubCtx.hubPoolChainId,
    node_count: topology.nodeContexts.length,
    edge_candidate_count: topology.edgeCandidates.length,
    rebalance_route_count: prepared.rebalanceRoutes.length,
    logical_assets: topology.logicalAssets,
    required_native_price_chains: [...topology.requiredNativePriceChains].sort((left, right) => left - right),
    rate_limit_buckets: topology.rateLimitBuckets,
    nodes: topology.nodeContexts
      .map(({ definition }) => definition)
      .sort((left, right) => left.node_key.localeCompare(right.node_key)),
    edge_candidates: topology.edgeCandidates
      .map(serializeEdgeCandidate)
      .sort((left, right) => left.edge_id.localeCompare(right.edge_id)),
    rebalance_routes: prepared.rebalanceRoutes
      .map(serializeRebalanceRoute)
      .sort((left, right) => rebalanceRouteKey(left).localeCompare(rebalanceRouteKey(right))),
  }) as JussiTopologyArtifactJson;
}

function rebalanceRouteKey(route: SerializedRebalanceRoute): string {
  return [route.source_chain, route.source_token, route.destination_chain, route.destination_token, route.adapter].join(
    "|"
  );
}

function serializeEdgeCandidate(candidate: GraphEdgeCandidate): JussiTopologyArtifactJson["edge_candidates"][number] {
  return {
    edge_id: resolveSerializedEdgeId(candidate),
    edge_class_id: resolveEdgeClassId(candidate),
    family: candidate.family,
    adapter_or_bridge_name: candidate.adapterOrBridgeName,
    effective_bridge_name: candidate.effectiveBridgeName,
    from_node_key: candidate.from.nodeKey,
    to_node_key: candidate.to.nodeKey,
    rate_limit_bucket_id: resolveRateLimitBucketId(candidate.family),
    rebalance_route: candidate.rebalanceRoute ? serializeRebalanceRoute(candidate.rebalanceRoute) : undefined,
  };
}

function serializeRebalanceRoute(route: NonNullable<GraphEdgeCandidate["rebalanceRoute"]>): SerializedRebalanceRoute {
  return {
    source_chain: route.sourceChain,
    source_token: route.sourceToken,
    destination_chain: route.destinationChain,
    destination_token: route.destinationToken,
    adapter: route.adapter,
  };
}
