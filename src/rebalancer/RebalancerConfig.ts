import { typeguards } from "@across-protocol/sdk";
import { CommonConfig, ProcessEnv } from "../common";
import { assert, BigNumber, isDefined, readFileSync, toBNWei, getTokenInfoFromSymbol, toBN } from "../utils";

/**
 * Expected JSON config format:
 * {
 *   "cumulativeBalances": {
 *     "USDT": { "threshold": "1000000", "target": "1500000", "priorityTier": 0, "chains": { "1": 0 } },
 *     "USDC": { "threshold": "3000000", "target": "3500000", "priorityTier": 0, "chains": { "1": 0 } }
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
 * - cumulativeTargetBalance values are human-readable amounts (e.g. "100" for 100 USDT) and will be
 *   converted to the token's native decimals on the respective chain.
 * - priorityTiers are essentially numbers that you assign to a chain based on how important it is to hold
 *   liquidity or meet the target balance on that chain. The higher priority deficits are filled first and the lowest
 *   priority excesses are used first.
 * - maxAmountsToTransfer values follow the same convention and will be converted to the origin chain's
 *   native decimals.
 * - maxPendingOrders is a map of adapter names to the maximum number of pending orders that should be allowed
 *   simultaneously for that adapter.
 */

interface ChainConfig {
  // This should be possible to set to 0 (to indicate that a chain should hold zero funds) or
  // positive infinity (to indicate that a chain should be the universal sink for the given token).
  targetBalance: BigNumber;
  // If balance is below this threshold, rebalance will be triggered back to the target balance.
  thresholdBalance: BigNumber;
  // Set this higher to prioritize returning this balance (if below target) back to target or deprioritize
  // sending this balance when above target.
  priorityTier: number;
  // Chains that this token can be rebalanced to.
  chains: { [chainId: number]: number };
}

export interface CumulativeTargetBalanceConfig {
  [token: string]: ChainConfig;
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
            targetBalance: string;
            thresholdBalance: string;
            priorityTier: number;
            chains: { [chainId: number]: number };
          }
        >
      )) {
        const { decimals: l1TokenDecimals } = getTokenInfoFromSymbol(token, this.hubPoolChainId);
        const { targetBalance, thresholdBalance, priorityTier } = chainConfig;
        assert(
          targetBalance !== undefined && thresholdBalance !== undefined && priorityTier !== undefined,
          `Bad config. Must specify targetBalance, thresholdBalance, priorityTier for ${token} for cumulative target balance`
        );
        assert(
          toBN(thresholdBalance).lte(toBN(targetBalance)),
          `Bad config. thresholdBalance<=targetBalance for ${token} for cumulative target balance`
        );
        Object.keys(chainConfig.chains).forEach((chainId) => {
          chainIdSet.add(Number(chainId));
        });
        this.cumulativeTargetBalances[token] = {
          targetBalance: toBNWei(targetBalance, l1TokenDecimals),
          thresholdBalance: toBNWei(thresholdBalance, l1TokenDecimals),
          priorityTier,
          chains: Object.fromEntries(
            Object.entries(chainConfig.chains).map(([chainId, priorityTier]) => [Number(chainId), priorityTier])
          ),
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
