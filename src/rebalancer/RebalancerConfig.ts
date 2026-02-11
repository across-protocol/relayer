import { typeguards } from "@across-protocol/sdk";
import { CommonConfig, ProcessEnv } from "../common";
import { assert, BigNumber, isDefined, readFileSync, toBNWei, getTokenInfoFromSymbol } from "../utils";
import { TargetBalanceConfig } from "./rebalancer";

/**
 * Expected JSON config format:
 * {
 *   "targetBalances": {
 *     "USDT": {
 *       "1": { "targetBalance": "0", "priorityTier": 0 },
 *       "42161": { "targetBalance": "100", "priorityTier": 1 }
 *     },
 *     "USDC": { ... }
 *   },
 *   "maxAmountsToTransfer": {
 *     "USDT": { "1": "1000", "42161": "500" },
 *     "USDC": { ... }
 *   }
 * }
 *
 * - targetBalance values are human-readable amounts (e.g. "100" for 100 USDT) and will be
 *   converted to the token's native decimals on the respective chain.
 * - maxAmountsToTransfer values follow the same convention.
 * - chainIds are derived automatically as the union of all chain IDs present in targetBalances.
 */
export class RebalancerConfig extends CommonConfig {
  public targetBalances: TargetBalanceConfig;
  public maxAmountsToTransfer: { [token: string]: { [sourceChainId: number]: BigNumber } };
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
      for (const [chainId, chainConfig] of Object.entries(
        chains as Record<string, { targetBalance: string; priorityTier: number }>
      )) {
        const { decimals } = getTokenInfoFromSymbol(token, Number(chainId));
        this.targetBalances[token][Number(chainId)] = {
          targetBalance: toBNWei(chainConfig.targetBalance, decimals),
          priorityTier: chainConfig.priorityTier,
        };
        chainIdSet.add(Number(chainId));
      }
    }

    // Parse max amounts to transfer from config.
    this.maxAmountsToTransfer = {};
    if (isDefined(rebalancerConfig.maxAmountsToTransfer)) {
      for (const [token, chains] of Object.entries(rebalancerConfig.maxAmountsToTransfer)) {
        this.maxAmountsToTransfer[token] = {};
        for (const [chainId, amount] of Object.entries(chains as Record<string, string>)) {
          const { decimals } = getTokenInfoFromSymbol(token, Number(chainId));
          this.maxAmountsToTransfer[token][Number(chainId)] = toBNWei(amount, decimals);
        }
      }
    }

    // Derive chain IDs from the union of all chains in targetBalances.
    this.chainIds = Array.from(chainIdSet);
  }
}
