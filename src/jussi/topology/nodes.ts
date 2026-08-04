import { InventoryConfig, TokenBalanceConfig, isAliasConfig } from "../../interfaces/InventoryManagement";
import assert from "assert";
import { bnZero, formatUnits, getTokenInfo, toAddressType, toBNWei } from "../../utils/SDKUtils";
import { getTokenInfoFromSymbol } from "../../utils/TokenUtils";
import { isDefined } from "../../utils/TypeGuards";
import { DEFAULT_HUB_POOL_CHAIN_ID, JUSSI_LOGICAL_ASSETS } from "../constants";
import type { JussiNodeDefinition, ManagedNodeContext, ManagedNodeRatios, ManagedNodeTemplate } from "../types";

export function canonicalNodeKey(chainId: number, tokenAddress: string): string {
  return `evm:${chainId}:${tokenAddress.toLowerCase()}`;
}

export function buildManagedNodeTemplates(
  inventoryConfig: InventoryConfig,
  hubChainId = DEFAULT_HUB_POOL_CHAIN_ID
): ManagedNodeTemplate[] {
  const templates = new Map<string, ManagedNodeTemplate>();

  const addTemplate = (template: ManagedNodeTemplate) => {
    const nodeKey = canonicalNodeKey(template.chainId, template.tokenAddress);
    templates.set(nodeKey, template);
  };

  for (const logicalAsset of JUSSI_LOGICAL_ASSETS) {
    const hubTokenInfo = getTokenInfoFromSymbol(logicalAsset, hubChainId);
    addTemplate({
      chainId: hubChainId,
      tokenAddress: hubTokenInfo.address.toNative(),
      symbol: hubTokenInfo.symbol,
      logicalAsset,
      decimals: hubTokenInfo.decimals,
      managed: false,
    });

    const tokenConfig = inventoryConfig.tokenConfig?.[hubTokenInfo.address.toNative()];
    if (!isDefined(tokenConfig)) {
      continue;
    }

    if (isAliasConfig(tokenConfig)) {
      Object.entries(tokenConfig).forEach(([spokeTokenAddress, chainConfig]) => {
        Object.entries(chainConfig).forEach(([chainIdString, balanceConfig]) => {
          const chainId = Number(chainIdString);
          const tokenInfo = getTokenInfo(toAddressType(spokeTokenAddress, chainId), chainId);
          addTemplate({
            chainId,
            tokenAddress: spokeTokenAddress,
            symbol: tokenInfo.symbol,
            logicalAsset,
            decimals: tokenInfo.decimals,
            tokenConfig: balanceConfig,
            managed: true,
          });
        });
      });
      continue;
    }

    Object.entries(tokenConfig).forEach(([chainIdString, balanceConfig]) => {
      const chainId = Number(chainIdString);
      const tokenInfo = getTokenInfoFromSymbol(logicalAsset, chainId);
      addTemplate({
        chainId,
        tokenAddress: tokenInfo.address.toNative(),
        symbol: tokenInfo.symbol,
        logicalAsset,
        decimals: tokenInfo.decimals,
        tokenConfig: balanceConfig,
        managed: true,
      });
    });
  }

  return Array.from(templates.values()).sort((a, b) => a.chainId - b.chainId || a.symbol.localeCompare(b.symbol));
}

export function materializeNodeDefinitions(templates: ManagedNodeTemplate[]): ManagedNodeContext[] {
  const managedNodeRatios = resolveManagedNodeRatios(templates);
  return templates.map((template) => {
    const nodeKey = canonicalNodeKey(template.chainId, template.tokenAddress);
    let definition: JussiNodeDefinition;
    if (template.managed) {
      const ratios = managedNodeRatios.get(nodeKey);
      assert(isDefined(ratios), `Managed node ${template.symbol} on ${template.chainId} is missing normalized ratios`);
      definition = buildManagedNodeDefinition(template, ratios);
    } else {
      definition = buildNeutralNodeDefinition(template);
    }

    return {
      ...template,
      nodeKey,
      definition: {
        ...definition,
        node_key: nodeKey,
      },
    };
  });
}

function resolveManagedNodeRatios(templates: ManagedNodeTemplate[]): Map<string, ManagedNodeRatios> {
  type ManagedNodeTemplateWithTokenConfig = ManagedNodeTemplate & { tokenConfig: TokenBalanceConfig };
  const managedTemplatesByLogicalAsset = Map.groupBy(
    templates.filter(
      (template): template is ManagedNodeTemplateWithTokenConfig => template.managed && isDefined(template.tokenConfig)
    ),
    (template) => template.logicalAsset
  );
  const normalizedRatios = new Map<string, ManagedNodeRatios>();
  const unitRatio = toBNWei(1);

  Array.from(managedTemplatesByLogicalAsset.values()).forEach((logicalAssetTemplates) => {
    const totalTargetAllocation = logicalAssetTemplates.reduce(
      (sum, template) => sum.add(template.tokenConfig.targetPct),
      bnZero
    );

    if (totalTargetAllocation.eq(0)) {
      logicalAssetTemplates.forEach((template) => {
        normalizedRatios.set(canonicalNodeKey(template.chainId, template.tokenAddress), {
          targetAllocationRatio: bnZero,
          minAllocationRatio: bnZero,
          maxAllocationRatio: bnZero,
        });
      });
      return;
    }

    const positiveTargetTemplates = logicalAssetTemplates.filter((template) => template.tokenConfig.targetPct.gt(0));
    let assignedTargetAllocation = bnZero;

    positiveTargetTemplates.forEach((template, index) => {
      const tokenConfig = template.tokenConfig;
      const rawMaxAllocation = tokenConfig.targetPct.mul(tokenConfig.targetOverageBuffer).div(unitRatio);
      const isLastPositiveTarget = index === positiveTargetTemplates.length - 1;
      const targetAllocationRatio = isLastPositiveTarget
        ? unitRatio.sub(assignedTargetAllocation)
        : tokenConfig.targetPct.mul(unitRatio).div(totalTargetAllocation);
      const minAllocationRatio = tokenConfig.thresholdPct.mul(unitRatio).div(totalTargetAllocation);
      const maxAllocationRatio = rawMaxAllocation.mul(unitRatio).div(totalTargetAllocation);

      assignedTargetAllocation = assignedTargetAllocation.add(targetAllocationRatio);
      normalizedRatios.set(canonicalNodeKey(template.chainId, template.tokenAddress), {
        targetAllocationRatio,
        minAllocationRatio: minAllocationRatio.gt(targetAllocationRatio) ? targetAllocationRatio : minAllocationRatio,
        maxAllocationRatio: maxAllocationRatio.lt(targetAllocationRatio) ? targetAllocationRatio : maxAllocationRatio,
      });
    });

    logicalAssetTemplates
      .filter((template) => template.tokenConfig.targetPct.eq(0))
      .forEach((template) => {
        normalizedRatios.set(canonicalNodeKey(template.chainId, template.tokenAddress), {
          targetAllocationRatio: bnZero,
          minAllocationRatio: bnZero,
          maxAllocationRatio: bnZero,
        });
      });
  });

  return normalizedRatios;
}

function buildManagedNodeDefinition(template: ManagedNodeTemplate, ratios: ManagedNodeRatios): JussiNodeDefinition {
  return {
    node_key: "",
    chain_id: template.chainId,
    token_address: template.tokenAddress,
    symbol: template.symbol,
    logical_asset: template.logicalAsset,
    decimals: template.decimals,
    target_allocation_ratio: formatUnits(ratios.targetAllocationRatio, 18),
    min_allocation_ratio: formatUnits(ratios.minAllocationRatio, 18),
    max_allocation_ratio: formatUnits(ratios.maxAllocationRatio, 18),
  };
}

function buildNeutralNodeDefinition(template: ManagedNodeTemplate): JussiNodeDefinition {
  return {
    node_key: "",
    chain_id: template.chainId,
    token_address: template.tokenAddress,
    symbol: template.symbol,
    logical_asset: template.logicalAsset,
    decimals: template.decimals,
    target_allocation_ratio: "0",
    min_allocation_ratio: "0",
    max_allocation_ratio: "0",
    shortage_cost_usd_per_unit_time: "0",
    surplus_cost_usd_per_unit_time: "0",
  };
}
