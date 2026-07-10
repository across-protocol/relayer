import { CHAIN_IDs, isDefined } from "../utils";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalanceRoute } from "./utils/interfaces";

type AdapterName = "binance" | "hyperliquid" | "cctp" | "oft";

const SAME_ASSET_ROUTES_SUPPORTED: Record<string, Record<number, AdapterName>> = {
  USDT: {
    "43114": "binance",
  },
};

// @dev For now, the SameAssetRebalancerClient only supports rebalancing between L1 and the listed L2 chains in
// the mapping above.
export function buildSameAssetRebalanceRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  const routes = new Set<RebalanceRoute>();

  // If a supported route exists in the rebalancer config, return it.
  for (const [token, chainConfig] of Object.entries(SAME_ASSET_ROUTES_SUPPORTED)) {
    for (const [chainId, adapter] of Object.entries(chainConfig)) {
      if (
        isDefined(rebalancerConfig.sameAssetBalances?.[token]?.[Number(chainId)]) &&
        Number(chainId) !== CHAIN_IDs.MAINNET
      ) {
        routes.add({
          sourceChain: CHAIN_IDs.MAINNET,
          destinationChain: Number(chainId),
          sourceToken: token,
          destinationToken: token,
          adapter: adapter,
        });
      }
    }
  }
  return Array.from(routes);
}
