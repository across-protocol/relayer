import { typeguards } from "@across-protocol/sdk";
import { CommonConfig, ProcessEnv } from "../common";
import { assert, BigNumber, isDefined, readFileSync, toBNWei, getTokenInfoFromSymbol, toBN } from "../utils";

/**
 * Expected JSON config format:
 * {
 *   "targetBalances": {
 *     "USDT": {
 *       "1": { "targetBalance": "0", "thresholdBalance": "0", "priorityTier": 0 },
 *       "42161": { "targetBalance": "100", "thresholdBalance": "50", "priorityTier": 1 }
 *     },
 *     "USDC": { ... }
 *   },
 *   "maxAmountsToTransfer": {
 *     "USDT": "1000",
 *     "USDC": "1000"
 *   }
 * }
 *
 * - targetBalance values are human-readable amounts (e.g. "100" for 100 USDT) and will be
 *   converted to the token's native decimals on the respective chain.
 * - maxAmountsToTransfer values follow the same convention and will be converted to the origin chain's
 *   native decimals.
 * - chainIds are derived automatically as the union of all chain IDs present in targetBalances.
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
}

interface TokenConfig {
  [chainId: number]: ChainConfig;
}

export interface TargetBalanceConfig {
  [token: string]: TokenConfig;
}

export interface MaxAmountToTransferChainConfig {
  [chainId: number]: BigNumber;
}

export interface MaxAmountToTransferConfig {
  [token: string]: MaxAmountToTransferChainConfig;
}

export class RebalancerConfig extends CommonConfig {
  public targetBalances: TargetBalanceConfig;
  public maxAmountsToTransfer: MaxAmountToTransferConfig;
  public chainIds: number[];
  constructor(env: ProcessEnv) {
    const { REBALANCER_CONFIG, REBALANCER_EXTERNAL_CONFIG } = env;
    super(env);

    assert(
      !isDefined(REBALANCER_EXTERNAL_CONFIG) || !isDefined(REBALANCER_CONFIG),
      "Concurrent inventory management configurations detected."
    );
    let rebalancerConfig;
    try {
      rebalancerConfig = isDefined(REBALANCER_EXTERNAL_CONFIG)
        ? JSON.parse(readFileSync(REBALANCER_EXTERNAL_CONFIG))
        : JSON.parse(REBALANCER_CONFIG ?? "{}");
    } catch (err) {
      const msg = typeguards.isError(err) ? err.message : (err as Record<string, unknown>)?.code;
      throw new Error(`Inventory config error (${msg ?? "unknown error"})`);
    }

    const chainIdSet = new Set<number>();

    // Parse target balances from config, converting human-readable amounts to BigNumber
    // using the token's native decimals on each chain.
    if (!isDefined(rebalancerConfig.targetBalances)) {
      throw new Error("rebalancerConfig.targetBalances is required");
    }
    this.targetBalances = {};
    for (const [token, chains] of Object.entries(rebalancerConfig.targetBalances)) {
      this.targetBalances[token] = {};
      for (const [chainId, chainConfig] of Object.entries(chains as Record<string, {
        targetBalance: string;
        thresholdBalance: string;
        priorityTier: number;
      }>)) {
        const { targetBalance, thresholdBalance, priorityTier } = chainConfig;
        const { decimals } = getTokenInfoFromSymbol(token, Number(chainId));
        // Validate the ChainConfig:
        assert(
          targetBalance !== undefined && thresholdBalance !== undefined && priorityTier !== undefined,
          `Bad config. Must specify targetBalance, thresholdBalance, priorityTier for ${token} on ${chainId}`
        );
        assert(
          toBN(thresholdBalance).lte(toBN(targetBalance)),
          `Bad config. thresholdBalance<=targetBalance for ${token} on ${chainId}`
        );
        this.targetBalances[token][Number(chainId)] = {
          targetBalance: toBNWei(targetBalance, decimals),
          thresholdBalance: toBNWei(thresholdBalance, decimals),
          priorityTier,
        };
        chainIdSet.add(Number(chainId));
      }
    }

    // Parse max amounts to transfer from config.
    this.maxAmountsToTransfer = {};
    if (isDefined(rebalancerConfig.maxAmountsToTransfer)) {
      for (const [token, amount] of Object.entries(rebalancerConfig.maxAmountsToTransfer as Record<string, string>)) {
        this.maxAmountsToTransfer[token] ??= {};
        for (const chainId of chainIdSet) {
          const { decimals } = getTokenInfoFromSymbol(token, chainId);
          this.maxAmountsToTransfer[token][chainId] = toBNWei(amount, decimals);
        }
      }
    }

    // Derive chain IDs from the union of all chains in targetBalances.
    this.chainIds = Array.from(chainIdSet);
  }
}
