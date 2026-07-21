import { chainIsSvm } from "../utils/SDKUtils";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { RebalancerConfig } from "../rebalancer/RebalancerConfig";
import { buildRebalanceRoutes } from "../rebalancer/buildRebalanceRoutes";
import { buildSameAssetRebalanceRoutes } from "../rebalancer/buildSameAssetRebalanceRoutes";
import type { RebalanceRoute } from "../rebalancer/utils/interfaces";
import { getTokenInfoFromSymbol } from "../utils/TokenUtils";
import { buildTopology } from "./topology/buildTopology";
import { buildBridgeAdapterRoutes } from "./topology/edges";
import { buildManagedNodeTemplates, canonicalNodeKey, materializeNodeDefinitions } from "./topology/nodes";
import type { ManagedNodeContext, PreparedGraphTopology } from "./types";

function assertSameAssetRouteNodesExist(
  sameAssetRoutes: RebalanceRoute[],
  nodeContexts: ManagedNodeContext[],
  hubPoolChainId: number
): void {
  const nodeContextsByKey = new Map(nodeContexts.map((nodeContext) => [nodeContext.nodeKey, nodeContext]));

  for (const route of sameAssetRoutes) {
    const routeDescription = `${route.sourceToken} on chain ${route.sourceChain} -> ${route.destinationToken} on chain ${route.destinationChain} via ${route.adapter}`;
    const endpoints = [
      { role: "source", token: route.sourceToken, chainId: route.sourceChain },
      { role: "destination", token: route.destinationToken, chainId: route.destinationChain },
    ] as const;

    for (const { role, token, chainId } of endpoints) {
      const tokenInfo = getTokenInfoFromSymbol(token, chainId);
      const nodeKey = canonicalNodeKey(chainId, tokenInfo.address.toNative());
      const nodeContext = nodeContextsByKey.get(nodeKey);
      // Hub asset nodes are always materialized as neutral graph entry points. Every non-hub endpoint must be
      // explicitly managed by InventoryConfig so SameAsset routes cannot synthesize an unsupported destination.
      if (!nodeContext || (chainId !== hubPoolChainId && !nodeContext.managed)) {
        throw new Error(
          `SameAsset rebalance route ${routeDescription} is missing its ${role} InventoryConfig node ${nodeKey}`
        );
      }
    }
  }
}

export async function prepareGraphTopology(params: {
  relayerConfig: RelayerConfig;
  rebalancerConfig: RebalancerConfig;
}): Promise<PreparedGraphTopology> {
  const { relayerConfig, rebalancerConfig } = params;
  const hubCtx = { hubPoolChainId: relayerConfig.hubPoolChainId };
  const nodeContexts = materializeNodeDefinitions(
    buildManagedNodeTemplates(relayerConfig.inventoryConfig, hubCtx.hubPoolChainId).filter(
      (template) => !chainIsSvm(template.chainId)
    )
  );
  const sameAssetRoutes = buildSameAssetRebalanceRoutes(rebalancerConfig);
  assertSameAssetRouteNodesExist(sameAssetRoutes, nodeContexts, hubCtx.hubPoolChainId);
  const bridgeAdapterRoutes = buildBridgeAdapterRoutes({
    nodeContexts,
    hubPoolChainId: hubCtx.hubPoolChainId,
  });
  const rebalanceRoutes = [...buildRebalanceRoutes(rebalancerConfig), ...sameAssetRoutes, ...bridgeAdapterRoutes];
  const topology = buildTopology({
    rebalanceRoutes,
    hubPoolChainId: hubCtx.hubPoolChainId,
    nodeContexts,
  });

  return {
    relayerConfig,
    rebalancerConfig,
    hubCtx,
    rebalanceRoutes,
    topology,
  };
}
