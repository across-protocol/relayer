import { EXPECTED_L1_TO_L2_MESSAGE_TIME, SLOW_WITHDRAWAL_CHAINS } from "../../common/Constants";
import { CHAIN_IDs } from "../../utils";
import {
  DEFAULT_HUB_POOL_CHAIN_ID,
  LATENCY_BY_FAMILY,
  LINEA_SCROLL_WITHDRAWAL_LATENCY_SECONDS,
  SLOW_WITHDRAWAL_LATENCY_SECONDS,
  ZKSTACK_WITHDRAWAL_LATENCY_SECONDS,
} from "../constants";
import type { EdgeFamily, GraphEdgeCandidate, LogicalAsset } from "../types";

export { LATENCY_BY_FAMILY } from "../constants";

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
  candidate: Pick<GraphEdgeCandidate, "family" | "adapterOrBridgeName" | "from" | "to">,
  hubPoolChainId = DEFAULT_HUB_POOL_CHAIN_ID
): number {
  if (candidate.family === "cctp" || candidate.family === "oft") {
    return resolveBridgeLatencySeconds(candidate.family, candidate.from.chainId, candidate.from.logicalAsset);
  }

  if (candidate.family === "binance_cex_bridge") {
    return LATENCY_BY_FAMILY.binance_cex_bridge;
  }

  if (candidate.from.chainId === hubPoolChainId) {
    return EXPECTED_L1_TO_L2_MESSAGE_TIME[candidate.to.chainId] ?? LATENCY_BY_FAMILY[candidate.family];
  }

  if (candidate.to.chainId === hubPoolChainId) {
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
