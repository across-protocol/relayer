import { chainIsSvm } from "../../utils/SDKUtils";
import { isDefined } from "../../utils/TypeGuards";
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
import { buildManagedNodeTemplates, materializeNodeDefinitions } from "./nodes";

export function buildTopology(params: BuildTopologyParams): JussiGraphTopology {
  const hubPoolChainId = params.hubCtx?.hubPoolChainId ?? params.relayerConfig.hubPoolChainId;
  const nodeTemplates = buildManagedNodeTemplates(params.relayerConfig.inventoryConfig, hubPoolChainId).filter(
    (template) => !chainIsSvm(template.chainId)
  );
  const nodeContexts = materializeNodeDefinitions(nodeTemplates);
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
    rateLimitBuckets: edgeCandidates.some((candidate) => isDefined(resolveRateLimitBucketId(candidate.family)))
      ? DEFAULT_RATE_LIMIT_BUCKETS
      : [],
  };
}
