import { chainIsSvm } from "../utils/SDKUtils";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { RebalancerConfig } from "../rebalancer/RebalancerConfig";
import { buildRebalanceRoutes } from "../rebalancer/buildRebalanceRoutes";
import { buildTopology } from "./topology/buildTopology";
import { buildBridgeAdapterRoutes } from "./topology/edges";
import { buildManagedNodeTemplates, materializeNodeDefinitions } from "./topology/nodes";
import { PreparedGraphTopology } from "./types";

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
  const bridgeAdapterRoutes = await buildBridgeAdapterRoutes({
    nodeContexts,
    hubPoolChainId: hubCtx.hubPoolChainId,
  });
  const rebalanceRoutes = [...buildRebalanceRoutes(rebalancerConfig), ...bridgeAdapterRoutes];
  const topology = buildTopology({
    relayerConfig,
    rebalanceRoutes,
    hubCtx,
  });

  return {
    relayerConfig,
    rebalancerConfig,
    hubCtx,
    rebalanceRoutes,
    topology,
  };
}
