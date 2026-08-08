import {
  CANONICAL_BRIDGE,
  CANONICAL_L2_BRIDGE,
  CUSTOM_BRIDGE,
  CUSTOM_L2_BRIDGE,
  LEGACY_MESH_NETWORKS,
  L2_TOKEN_SPLITTER_BRIDGES,
  TOKEN_SPLITTER_BRIDGES,
} from "../../common";
import { TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import assert from "assert";
import type { RebalanceRoute } from "../../rebalancer/utils/interfaces";
import { isSameBinanceCoin } from "../../utils/BinanceUtils";
import { EvmAddress, compareAddressesSimple } from "../../utils/SDKUtils";
import { getRemoteTokenForL1Token, getTokenInfoFromSymbol } from "../../utils/TokenUtils";
import { isDefined } from "../../utils/TypeGuards";
import { BINANCE_RATE_LIMIT_BUCKET_ID, DEFAULT_HUB_POOL_CHAIN_ID, JUSSI_LOGICAL_ASSETS } from "../constants";
import type {
  BridgeLookupContext,
  BridgeMatch,
  EdgeFamily,
  GraphEdgeCandidate,
  LogicalAsset,
  ManagedNodeContext,
} from "../types";
import { canonicalNodeKey } from "./nodes";

export function buildBridgeEdgeCandidates(
  nodeContexts: ManagedNodeContext[],
  hubPoolChainId = DEFAULT_HUB_POOL_CHAIN_ID
): GraphEdgeCandidate[] {
  const nodesByLogicalAssetChain = indexNodesByLogicalAssetAndChain(nodeContexts);
  const candidates: GraphEdgeCandidate[] = [];

  for (const logicalAsset of JUSSI_LOGICAL_ASSETS) {
    const l1Token = TOKEN_SYMBOLS_MAP[logicalAsset].addresses[hubPoolChainId];
    const chainMap = nodesByLogicalAssetChain.get(logicalAsset) ?? new Map<number, ManagedNodeContext[]>();
    const hubNode = nodeContexts.find((node) => node.logicalAsset === logicalAsset && node.chainId === hubPoolChainId);
    assert(isDefined(hubNode), `Missing hub node for ${logicalAsset}`);
    for (const [chainId, chainNodes] of chainMap.entries()) {
      if (chainId === hubPoolChainId) {
        continue;
      }

      const inboundBridge = CUSTOM_BRIDGE[chainId]?.[l1Token] ?? CANONICAL_BRIDGE[chainId];
      if (isDefined(inboundBridge)) {
        const bridgeContext = buildBridgeLookupContext(chainId, logicalAsset, inboundBridge.name, hubPoolChainId);
        candidates.push(
          ...chainNodes.flatMap((node) =>
            buildBridgeCandidate(
              resolveInboundBridgeMatch(node, bridgeContext),
              bridgeContext.adapterOrBridgeName,
              hubNode,
              node
            )
          )
        );
      }

      const outboundBridge = CUSTOM_L2_BRIDGE[chainId]?.[l1Token] ?? CANONICAL_L2_BRIDGE[chainId];
      if (isDefined(outboundBridge)) {
        const bridgeContext = buildBridgeLookupContext(chainId, logicalAsset, outboundBridge.name, hubPoolChainId);
        candidates.push(
          ...chainNodes.flatMap((node) =>
            buildBridgeCandidate(
              resolveOutboundBridgeMatch(node, bridgeContext),
              bridgeContext.adapterOrBridgeName,
              node,
              hubNode
            )
          )
        );
      }
    }
  }

  return candidates.filter(isSupportedJussiEdgeCandidate);
}

export function buildBridgeAdapterRoutes(params: {
  nodeContexts: ManagedNodeContext[];
  hubPoolChainId?: number;
}): RebalanceRoute[] {
  const routes = new Map<string, RebalanceRoute>();
  const bridgeCandidates = buildBridgeEdgeCandidates(params.nodeContexts, params.hubPoolChainId);

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

export function resolveOptionalTranslatedTokenAddress(
  l1Token: EvmAddress,
  chainId: number,
  hubPoolChainId = DEFAULT_HUB_POOL_CHAIN_ID
): string | undefined {
  const hubUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[hubPoolChainId];
  if (!compareAddressesSimple(l1Token.toNative(), hubUsdc)) {
    return getRemoteTokenForL1Token(l1Token, chainId, hubPoolChainId)?.toNative().toLowerCase();
  }

  const bridgedUsdcMapping = Object.values(TOKEN_SYMBOLS_MAP).find(
    ({ symbol, addresses }) =>
      symbol !== "USDC" && compareAddressesSimple(addresses[hubPoolChainId], l1Token.toNative()) && addresses[chainId]
  );

  return bridgedUsdcMapping?.addresses[chainId]?.toLowerCase();
}

function buildBridgeLookupContext(
  chainId: number,
  logicalAsset: LogicalAsset,
  adapterOrBridgeName: string,
  hubPoolChainId: number
): BridgeLookupContext {
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[logicalAsset].addresses[hubPoolChainId]);
  return {
    chainId,
    adapterOrBridgeName,
    canonicalRemoteToken: getRemoteTokenForL1Token(l1Token, chainId, hubPoolChainId)?.toNative().toLowerCase(),
    bridgedRemoteToken: resolveOptionalTranslatedTokenAddress(l1Token, chainId, hubPoolChainId),
    nativeUsdc: TOKEN_SYMBOLS_MAP.USDC.addresses[chainId]?.toLowerCase(),
    l1SplitterBridges: TOKEN_SPLITTER_BRIDGES[chainId]?.[l1Token.toNative()],
    l2SplitterBridges: L2_TOKEN_SPLITTER_BRIDGES[chainId]?.[l1Token.toNative()],
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
    case "TokenSplitterBridge":
      return resolveSplitterBridgeMatch(node, context, context.l2SplitterBridges, resolveOutboundBridgeMatch);
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

export function buildRebalanceEdgeCandidates(
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
    const family = familyForRebalanceRoute(route);
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

function familyForRebalanceRoute(route: RebalanceRoute): EdgeFamily {
  return route.adapter === "binance" && isSameBinanceCoin(route.sourceToken, route.destinationToken)
    ? "binance_cex_bridge"
    : (route.adapter as EdgeFamily);
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
  return Array.from(new Map(candidates.map((candidate) => [resolveSerializedEdgeId(candidate), candidate])).values());
}

export function isSupportedJussiEdgeCandidate(candidate: Pick<GraphEdgeCandidate, "family" | "from" | "to">): boolean {
  return (
    candidate.family !== "oft" ||
    (!LEGACY_MESH_NETWORKS.includes(candidate.from.chainId) && !LEGACY_MESH_NETWORKS.includes(candidate.to.chainId))
  );
}

export function resolveEdgeClassId(candidate: GraphEdgeCandidate): string {
  const qualifier = candidate.family === "cctp" ? ":standard" : "";
  return `${candidate.family}${qualifier}:${candidate.from.logicalAsset}:${candidate.to.logicalAsset}`;
}

export function resolveSerializedEdgeId(
  candidate: GraphEdgeCandidate,
  edgeClassId = resolveEdgeClassId(candidate)
): string {
  return [edgeClassId, candidate.from.nodeKey, candidate.to.nodeKey].join(":");
}

export function resolveRateLimitBucketId(family: EdgeFamily): string | undefined {
  return family === "binance" || family === "binance_cex_bridge" ? BINANCE_RATE_LIMIT_BUCKET_ID : undefined;
}

function indexNodesByLogicalAssetAndChain(
  nodeContexts: ManagedNodeContext[]
): Map<LogicalAsset, Map<number, ManagedNodeContext[]>> {
  return new Map(
    Array.from(
      Map.groupBy(nodeContexts, (node) => node.logicalAsset),
      ([logicalAsset, nodes]) => [logicalAsset, Map.groupBy(nodes, (node) => node.chainId)]
    )
  );
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
