import {
  BUILDER_TOPOLOGY_VERSION,
  CUMULATIVE_BALANCE_BANDS,
  DEFAULT_LATENCY_ANNUALIZED_COST_RATE,
  DEFAULT_PAIN_MODEL,
  LATENCY_BY_FAMILY,
} from "../constants";
import { sha256StableJson } from "../serialize";
import { JussiGraphTopology, JussiHubContext } from "../types";
import { resolveSerializedEdgeIdentity } from "./edges";

export function topologyFingerprint(topology: JussiGraphTopology, hubCtx: JussiHubContext): string {
  return sha256StableJson({
    builderTopologyVersion: BUILDER_TOPOLOGY_VERSION,
    hubPoolChainId: hubCtx.hubPoolChainId,
    nodes: topology.nodeContexts
      .map(({ definition }) => ({
        node_key: definition.node_key,
        chain_id: definition.chain_id,
        token_address: definition.token_address,
        symbol: definition.symbol,
        logical_asset: definition.logical_asset,
        decimals: definition.decimals,
        target_allocation_ratio: definition.target_allocation_ratio,
        min_allocation_ratio: definition.min_allocation_ratio,
        max_allocation_ratio: definition.max_allocation_ratio,
      }))
      .sort((left, right) => left.node_key.localeCompare(right.node_key)),
    dedupedEdgeIdentities: topology.edgeCandidates.map(resolveSerializedEdgeIdentity).sort(),
    logicalAssets: topology.logicalAssets,
    requiredNativePriceChains: [...topology.requiredNativePriceChains].sort((left, right) => left - right),
    painPolicy: {
      defaultPainModel: DEFAULT_PAIN_MODEL,
      cumulativeBalanceBands: CUMULATIVE_BALANCE_BANDS,
      latencyAnnualizedCostRate: DEFAULT_LATENCY_ANNUALIZED_COST_RATE,
    },
    rateLimitBuckets: topology.rateLimitBuckets,
    latencyPolicy: {
      latencyByFamily: LATENCY_BY_FAMILY,
      ruleIdentifiers: [
        "oft-usdt-hyperevm-24h",
        "l1-to-l2-expected-message-time",
        "zkstack-withdrawal",
        "linea-scroll-withdrawal",
        "opstack-and-slow-withdrawal-chains",
        "exchange-plus-source-destination-bridge-latency",
      ],
    },
  });
}
