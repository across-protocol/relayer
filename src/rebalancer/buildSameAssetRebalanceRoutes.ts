import { CHAIN_IDs, isDefined } from "../utils";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalanceRoute } from "./utils/interfaces";

export const SAME_ASSET_REBALANCE_ROUTE_SUPPORT = [
  { token: "USDT", chainId: CHAIN_IDs.AVALANCHE, adapter: "binance" },
] as const;

export type SameAssetRebalanceRouteSupport = (typeof SAME_ASSET_REBALANCE_ROUTE_SUPPORT)[number];

/**
 * @deprecated Configure AdapterManager bridges in common/Constants.ts instead. Retained as a rollback path.
 */
export function buildSameAssetRebalanceRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  return SAME_ASSET_REBALANCE_ROUTE_SUPPORT.filter(({ token, chainId }) =>
    isDefined(rebalancerConfig.sameAssetBalances?.[token]?.[chainId])
  ).map(({ token, chainId, adapter }) => ({
    sourceChain: CHAIN_IDs.MAINNET,
    destinationChain: chainId,
    sourceToken: token,
    destinationToken: token,
    adapter,
  }));
}
