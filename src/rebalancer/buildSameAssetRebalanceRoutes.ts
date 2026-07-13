import { CHAIN_IDs, isDefined } from "../utils";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalanceRoute } from "./utils/interfaces";

export const SAME_ASSET_REBALANCE_ROUTE_SUPPORT = [
  { token: "USDT", chainId: CHAIN_IDs.AVALANCHE, adapter: "binance" },
] as const;

export type SameAssetRebalanceRouteSupport = (typeof SAME_ASSET_REBALANCE_ROUTE_SUPPORT)[number];

// @dev For now, the SameAssetRebalancerClient only supports rebalancing between L1 and the listed L2 chains in
// the support catalog above.
export function buildSameAssetRebalanceRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  const routes: RebalanceRoute[] = [];

  // If a supported route exists in the rebalancer config, return it.
  for (const { token, chainId, adapter } of SAME_ASSET_REBALANCE_ROUTE_SUPPORT) {
    if (isDefined(rebalancerConfig.sameAssetBalances?.[token]?.[chainId]) && chainId !== CHAIN_IDs.MAINNET) {
      routes.push({
        sourceChain: CHAIN_IDs.MAINNET,
        destinationChain: chainId,
        sourceToken: token,
        destinationToken: token,
        adapter,
      });
    }
  }
  return routes;
}
