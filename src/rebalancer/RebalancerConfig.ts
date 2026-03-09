import { typeguards } from "@across-protocol/sdk";
import { CommonConfig, ProcessEnv } from "../common";
import { assert, BigNumber, isDefined, readFileSync, toBNWei, getTokenInfoFromSymbol, toBN } from "../utils";

/**
 * Expected JSON config format:
 * {
 *   "cumulativeBalances": {
 *     "targetBalanceConfig": {
 *       "USDT": { "thresholdLower": "1000000", "target": "1500000", "thresholdUpper": "INFINITY", "deficitPriorityTier": 0, "excessPriorityTier": 0 },
 *       "USDC": { "thresholdLower": "3000000", "target": "3500000", "thresholdUpper": "INFINITY", "deficitPriorityTier": 1, "excessPriorityTier": 0 }
 *     },
 *     "rebalanceRoutePreferencesConfig": {
 *       "sortedExcessSinks": [1, 42161],
 *       "sortedDeficitSources": [1, 10]
 *     }
 *   },
 *   "equivalentTokenBalances": {
 *     "targetBalanceConfig": {
 *       "USDT": {
 *         "1": { "thresholdLower": "1000000", "target": "1500000", "thresholdUpper": "INFINITY", "deficitPriorityTier": 0, "excessPriorityTier": 0 },
 *         "10": { "thresholdLower": "1000000", "target": "1500000", "thresholdUpper": "INFINITY", "deficitPriorityTier": 0, "excessPriorityTier": 0 }
 *       },
 *       "USDC": {
 *         "1": { "thresholdLower": "3000000", "target": "3500000", "thresholdUpper": "INFINITY", "deficitPriorityTier": 1, "excessPriorityTier": 0 },
 *         "10": { "thresholdLower": "3000000", "target": "3500000", "thresholdUpper": "INFINITY", "deficitPriorityTier": 1, "excessPriorityTier": 0 }
 *       }
 *     },
 *     "rebalanceRoutePreferencesConfig": {
 *       "sortedExcessSinks": [1, 42161],
 *       "sortedDeficitSources": [1, 10]
 *     }
 *   },
 *   "maxAmountsToTransfer": {
 *     "USDT": "1000",
 *     "USDC": "1000"
 *   },
 *   "maxPendingOrders": {
 *     "hyperliquid": 3,
 *     "binance": 3
 *   }
 * }
 *
 * - target balance values are human-readable amounts (e.g. "100" for 100 USDT) and will be
 *   converted to the token's native decimals on the respective chain.
 * - priority tiers are essentially numbers that you assign to a chain based on how important it is to hold
 *   liquidity or meet the target balance on that chain. 
 */

interface TargetBalanceConfig {
  // This should be possible to set to 0 (to indicate that a chain should hold zero funds) or
  // positive infinity (to indicate that a chain should be the universal sink for the given token).
  targetBalance: BigNumber;
  // If balance is below this threshold, rebalance will be triggered back to the target balance.
  thresholdBalanceLower: BigNumber;
  // If balance is above this threshold, rebalance will be triggered back to the target balance.
  thresholdBalanceUpper: BigNumber;
  // Set this higher to prioritize returning this balance (if below target) back to target. This value is only
  // useful when comparing relative to other deficit priority tiers.
  deficitPriorityTier: number;
  // Set this higher to prioritize returning this balance (if above target) back to target. 
  // This value is only useful when comparing relative to other excess priority tiers and is not compared against
  // any deficit priority tiers
  excessPriorityTier: number;
}

interface RebalanceRoutePreferencesConfig {
  // Ordering of chains that sink excess balances should be sent to to remove excess.
  sortedExcessSinks: number[];
  // Ordering of chains that source deficits should be sent from to fill deficits.
  sortedDeficitSources: number[];
  }

export interface CumulativeTargetBalanceConfig {
  [token: string]: {
    targetBalanceConfig: TargetBalanceConfig;
    // @todo: In the future, consider specifying rebalance route prefernces on a per-chain basis.
    rebalanceRoutePreferencesConfig: RebalanceRoutePreferencesConfig;
  };
}

export interface EquivalentTokenBalanceConfig {
  [token: string]: {
    [chainId: number]: {
      targetBalanceConfig: TargetBalanceConfig;
    }
    // @todo: In the future, consider specifying rebalance route prefernces on a per-chain basis.
    rebalanceRoutePreferencesConfig: RebalanceRoutePreferencesConfig;
  };
}

export interface MaxAmountToTransferChainConfig {
  [chainId: number]: BigNumber;
}

export interface MaxAmountToTransferConfig {
  [token: string]: MaxAmountToTransferChainConfig;
}

export interface MaxPendingOrdersConfig {
  [adapterName: string]: number;
}

export class RebalancerConfig extends CommonConfig {
  public cumulativeTargetBalances: CumulativeTargetBalanceConfig;
  public equivalentTokenBalances: EquivalentTokenBalanceConfig;

  // Max amounts to transfer and max pending orders are used to essentially rate limit an adapter to allow for
  // gradual testing and safety.
  public maxAmountsToTransfer: MaxAmountToTransferConfig;
  public maxPendingOrders: MaxPendingOrdersConfig;

  // chain IDs are derived automatically from targetBalances and cumulativeTargetBalances.
  public chainIds: number[];
  constructor(env: ProcessEnv) {
    const { REBALANCER_CONFIG, REBALANCER_EXTERNAL_CONFIG } = env;
    super(env);

    let rebalancerConfig;
    try {
      if (isDefined(REBALANCER_EXTERNAL_CONFIG)) {
        try {
          rebalancerConfig = JSON.parse(readFileSync(REBALANCER_EXTERNAL_CONFIG));
        } catch {
          if (isDefined(REBALANCER_CONFIG)) {
            rebalancerConfig = JSON.parse(REBALANCER_CONFIG);
          } else {
            throw new Error(
              "REBALANCER_EXTERNAL_CONFIG is set but file could not be read. Set REBALANCER_CONFIG to use internal config as fallback."
            );
          }
        }
      } else {
        rebalancerConfig = JSON.parse(REBALANCER_CONFIG ?? "{}");
      }
    } catch (err) {
      const msg = typeguards.isError(err) ? err.message : (err as Record<string, unknown>)?.code;
      throw new Error(`Rebalancer config error (${msg ?? "unknown error"})`);
    }

    const chainIdSet = new Set<number>();

    this.cumulativeTargetBalances = {};
    if (isDefined(rebalancerConfig.cumulativeTargetBalances)) {
      for (const [token, chainConfig] of Object.entries(
        rebalancerConfig.cumulativeTargetBalances as Record<
          string,
          {
            targetBalanceConfig: {
              targetBalance: string;
              thresholdBalanceLower: string;
              thresholdBalanceUpper: string;
              deficitPriorityTier: number;
              excessPriorityTier: number;
            };
            rebalanceRoutePreferencesConfig: RebalanceRoutePreferencesConfig;
          }
        >
      )) {
        const { decimals: l1TokenDecimals } = getTokenInfoFromSymbol(token, this.hubPoolChainId);
        const { targetBalanceConfig, rebalanceRoutePreferencesConfig } = chainConfig;
        const { targetBalance, thresholdBalanceLower, thresholdBalanceUpper, deficitPriorityTier, excessPriorityTier } = targetBalanceConfig;
        assert(
          targetBalance !== undefined &&
            thresholdBalanceLower !== undefined &&
            thresholdBalanceUpper !== undefined &&
            deficitPriorityTier !== undefined &&
            excessPriorityTier !== undefined,
          `Bad config. Must specify targetBalance, thresholdBalanceLower, thresholdBalanceUpper, deficitPriorityTier, excessPriorityTier for ${token} for cumulative target balance`
        );
        assert(
          toBN(thresholdBalanceLower).lte(toBN(targetBalance)) && toBN(thresholdBalanceUpper).gte(toBN(targetBalance)),
          `Bad config. thresholdBalanceLower<=targetBalance<=thresholdBalanceUpper for ${token} for cumulative target balance`
        );
        this.cumulativeTargetBalances[token] = {
          targetBalanceConfig: {
            targetBalance: toBNWei(targetBalance, l1TokenDecimals),
            thresholdBalanceLower: toBNWei(thresholdBalanceLower, l1TokenDecimals),
            thresholdBalanceUpper: toBNWei(thresholdBalanceUpper, l1TokenDecimals),
            deficitPriorityTier,
            excessPriorityTier,
          },
          rebalanceRoutePreferencesConfig,
        };
      }
    }

    // Parse max amounts to transfer from config.
    this.maxAmountsToTransfer = {};
    if (isDefined(rebalancerConfig.maxAmountsToTransfer)) {
      for (const [token, amount] of Object.entries(rebalancerConfig.maxAmountsToTransfer as Record<string, string>)) {
        this.maxAmountsToTransfer[token] ??= {};
        for (const chainId of chainIdSet) {
          try {
            const { decimals } = getTokenInfoFromSymbol(token, chainId);
            this.maxAmountsToTransfer[token][chainId] = toBNWei(amount, decimals);
          } catch (err) {
            // ignore, token doesn't exist on chain probably
          }
        }
      }
    }

    this.maxPendingOrders = {};
    if (isDefined(rebalancerConfig.maxPendingOrders)) {
      for (const [adapterName, maxPendingOrders] of Object.entries(
        rebalancerConfig.maxPendingOrders as Record<string, number>
      )) {
        this.maxPendingOrders[adapterName] = maxPendingOrders;
      }
    }

    // Derive chain IDs from the union of all chains in targetBalances.
    this.chainIds = Array.from(chainIdSet);
  }
}
