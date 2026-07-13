import { DEFAULT_RATE_LIMIT_BUCKETS } from "../constants";
import type { BuildTopologyParams, JussiGraphTopology } from "../types";
import {
  buildRebalanceEdgeCandidates,
  buildBridgeEdgeCandidates,
  dedupeGraphEdgeCandidates,
  isSupportedJussiEdgeCandidate,
  resolveRateLimitBucketId,
} from "./edges";
import { buildLogicalAssetDefinitions, resolveRequiredNativePriceChains } from "./logicalAssets";

export function buildTopology(params: BuildTopologyParams): JussiGraphTopology {
  const { hubPoolChainId, nodeContexts } = params;
  const nodesByKey = new Map(nodeContexts.map((node) => [node.nodeKey, node]));
  const bridgeCandidates = buildBridgeEdgeCandidates(nodeContexts, hubPoolChainId);
  const rebalanceCandidates = buildRebalanceEdgeCandidates(params.rebalanceRoutes, nodesByKey);
  const edgeCandidates = dedupeGraphEdgeCandidates(
    [...bridgeCandidates, ...rebalanceCandidates].filter(isSupportedJussiEdgeCandidate)
  );
  const logicalAssets = buildLogicalAssetDefinitions(nodeContexts, hubPoolChainId);
  const requiredNativePriceChains = resolveRequiredNativePriceChains(logicalAssets, nodeContexts);

  return {
    nodeContexts,
    edgeCandidates,
    logicalAssets,
    requiredNativePriceChains,
    rateLimitBuckets: edgeCandidates.some((candidate) => resolveRateLimitBucketId(candidate.family) !== undefined)
      ? DEFAULT_RATE_LIMIT_BUCKETS
      : [],
  };
}
