import { isDefined } from "../utils";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalanceRoute } from "./utils/interfaces";

type AdapterName = "binance" | "hyperliquid" | "cctp" | "oft";

const SAME_ASSET_ROUTES_SUPPORTED: Record<string, Record<number, AdapterName>> = {
  USDT: {
    "43114": "binance",
    "1": "binance",
  },
};
export function buildSameAssetRebalanceRoutes(rebalancerConfig: RebalancerConfig): RebalanceRoute[] {
  const routes = new Set<RebalanceRoute>();

  // If a supported route exists in the rebalancer config, return it.
  for (const [token, chainConfig] of Object.entries(SAME_ASSET_ROUTES_SUPPORTED)) {
    for (const [chainId, adapter] of Object.entries(chainConfig)) {
      for (const [otherChainId, otherAdapter] of Object.entries(chainConfig)) {
        if (
          Number(chainId) !== Number(otherChainId) &&
          adapter === otherAdapter &&
          isDefined(rebalancerConfig.sameAssetBalances?.[token]?.[Number(chainId)]) &&
          isDefined(rebalancerConfig.sameAssetBalances?.[token]?.[Number(otherChainId)])
        ) {
          routes.add({
            sourceChain: Number(chainId),
            destinationChain: Number(otherChainId),
            sourceToken: token,
            destinationToken: token,
            adapter: adapter,
          });
        }
      }
    }
  }
  return Array.from(routes);
}
