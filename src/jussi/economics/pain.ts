import type { BigNumber } from "../../utils";
import { CUMULATIVE_BALANCE_BANDS, DEFAULT_PAIN_MODEL, JUSSI_LOGICAL_ASSETS } from "../constants";
import type { JussiCumulativeBalancePainDefinition, LogicalAsset } from "../types";

export function buildCumulativeBalancePainDefinitions(
  cumulativeBalancesByLogicalAsset: Record<LogicalAsset, BigNumber>
): Record<string, JussiCumulativeBalancePainDefinition> {
  return Object.fromEntries(
    JUSSI_LOGICAL_ASSETS.map((logicalAsset) => {
      const targetBalanceNative = cumulativeBalancesByLogicalAsset[logicalAsset];
      const band = CUMULATIVE_BALANCE_BANDS[logicalAsset];
      return [
        logicalAsset,
        {
          target_balance_native: targetBalanceNative.toString(),
          min_threshold_native: targetBalanceNative.mul(band.minBps).div(10_000).toString(),
          max_threshold_native: targetBalanceNative.mul(band.maxBps).div(10_000).toString(),
          surplus_annualized_cost_rate: DEFAULT_PAIN_MODEL.surplus_annualized_cost_rate,
          deficit_annualized_cost_rate: DEFAULT_PAIN_MODEL.deficit_annualized_cost_rate,
          out_of_band_severity_multiplier: band.outOfBandSeverityMultiplier,
        },
      ];
    })
  );
}
