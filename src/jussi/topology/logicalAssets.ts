import { getNativeTokenInfoForChain } from "../../utils/TokenUtils";
import { DEFAULT_HUB_POOL_CHAIN_ID, JUSSI_LOGICAL_ASSETS } from "../constants";
import type { JussiLogicalAssetDefinition, LogicalAsset, ManagedNodeContext } from "../types";

export function buildLogicalAssetDefinitions(
  nodeContexts: ManagedNodeContext[],
  hubPoolChainId = DEFAULT_HUB_POOL_CHAIN_ID
): Record<string, JussiLogicalAssetDefinition> {
  return Object.fromEntries(
    JUSSI_LOGICAL_ASSETS.map((logicalAsset) => {
      const decimals_by_chain = Object.fromEntries(
        nodeContexts
          .filter((node) => node.logicalAsset === logicalAsset)
          .map((node) => [String(node.chainId), node.decimals])
          .sort(([a], [b]) => Number(a) - Number(b))
      );
      const native_price_alias_chain_ids = Object.keys(decimals_by_chain)
        .filter((chainId) => resolveNativePriceAliasLogicalAsset(Number(chainId), hubPoolChainId) === logicalAsset)
        .sort((a, b) => Number(a) - Number(b));
      return [
        logicalAsset,
        {
          decimals_by_chain,
          ...(native_price_alias_chain_ids.length > 0 ? { native_price_alias_chain_ids } : {}),
        },
      ];
    })
  );
}

export function resolveNativePriceAliasLogicalAsset(
  chainId: number,
  hubPoolChainId = DEFAULT_HUB_POOL_CHAIN_ID
): LogicalAsset | undefined {
  const nativeTokenSymbol = getNativeTokenInfoForChain(chainId, hubPoolChainId).symbol;
  if (nativeTokenSymbol === "ETH" || nativeTokenSymbol === "WETH") {
    return "WETH";
  }
  if (nativeTokenSymbol === "USDC" || nativeTokenSymbol === "USDC.e") {
    return "USDC";
  }
  if (nativeTokenSymbol === "USDT") {
    return "USDT";
  }
  return undefined;
}

export function resolveRequiredNativePriceChains(
  logicalAssets: Record<string, JussiLogicalAssetDefinition>,
  nodeContexts: ManagedNodeContext[]
): number[] {
  const coveredChainIds = new Set(
    Object.values(logicalAssets)
      .flatMap((definition) => definition.native_price_alias_chain_ids ?? [])
      .map(Number)
  );
  return Array.from(new Set(nodeContexts.map((node) => node.chainId)))
    .sort((a, b) => a - b)
    .filter((chainId) => !coveredChainIds.has(chainId));
}
