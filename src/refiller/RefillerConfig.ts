import { CommonConfig, ProcessEnv } from "../common";
import { getNativeTokenAddressForChain, Address, toAddressType, isDefined, toBNWei, BigNumber } from "../utils";

export type RefillBalanceData = {
  chainId: number;
  isHubPool: boolean;
  account: Address;
  token: Address;
  target: number;
  trigger: number;
  refillPeriod?: number;
  // If true, check origin chain balance. If false, check destination chain balance (default).
  checkOriginChainBalance: boolean;
};

export class RefillerConfig extends CommonConfig {
  readonly refillEnabledBalances: RefillBalanceData[] = [];
  readonly nativeMarketsApiConfig: { apiKey: string; apiUrl: string };
  readonly minUsdhRebalanceAmount: BigNumber;

  constructor(env: ProcessEnv) {
    super(env);

    const { REFILL_BALANCES, NATIVE_MARKETS_API_KEY, NATIVE_MARKETS_API_BASE, MIN_USDH_REBALANCE_AMOUNT } = env;

    // Used to send tokens if available in wallet to balances under target balances.
    if (REFILL_BALANCES) {
      this.refillEnabledBalances = JSON.parse(REFILL_BALANCES).map(
        ({ chainId, account, isHubPool, target, trigger, token, checkOriginChainBalance }) => {
          if (Number.isNaN(target) || target <= 0) {
            throw new Error(`target for ${chainId} and ${account} must be > 0, got ${target}`);
          }
          if (Number.isNaN(trigger) || trigger <= 0) {
            throw new Error(`trigger for ${chainId} and ${account} must be > 0, got ${trigger}`);
          }
          if (trigger >= target) {
            throw new Error("trigger must be < target");
          }
          return {
            // Required fields:
            chainId,
            account: toAddressType(account, chainId),
            target,
            trigger,
            // Optional fields that will set to defaults:
            isHubPool: Boolean(isHubPool),
            token: isDefined(token) ? toAddressType(token, chainId) : getNativeTokenAddressForChain(chainId),
            checkOriginChainBalance: isDefined(checkOriginChainBalance) ? Boolean(checkOriginChainBalance) : false,
          };
        }
      );
    }

    if (isDefined(NATIVE_MARKETS_API_KEY) && isDefined(NATIVE_MARKETS_API_BASE)) {
      this.nativeMarketsApiConfig = { apiKey: NATIVE_MARKETS_API_KEY, apiUrl: NATIVE_MARKETS_API_BASE };
    }

    // Default minimum is 10 USDH. USDH only exists on HyperEVM and has 6 decimals.
    this.minUsdhRebalanceAmount = toBNWei(MIN_USDH_REBALANCE_AMOUNT ?? "10", 6);

    // Should only have 1 HubPool.
    if (Object.values(this.refillEnabledBalances).filter((x) => x.isHubPool).length > 1) {
      throw new Error("REFILL_BALANCES should only have 1 account marked isHubPool as true");
    }
  }
}
