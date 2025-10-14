import { CommonConfig, ProcessEnv } from "../common";
import { getNativeTokenAddressForChain, Address, toAddressType, isDefined } from "../utils";

export class RefillerConfig extends CommonConfig {
  readonly refillEnabledBalances: {
    chainId: number;
    isHubPool: boolean;
    account: Address;
    token: Address;
    target: number;
    trigger: number;
  }[] = [];

  constructor(env: ProcessEnv) {
    super(env);

    const { REFILL_BALANCES } = env;

    // Used to send tokens if available in wallet to balances under target balances.
    if (REFILL_BALANCES) {
      this.refillEnabledBalances = JSON.parse(REFILL_BALANCES).map(
        ({ chainId, account, isHubPool, target, trigger, token }) => {
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
          };
        }
      );
    }

    // Should only have 1 HubPool.
    if (Object.values(this.refillEnabledBalances).filter((x) => x.isHubPool).length > 1) {
      throw new Error("REFILL_BALANCES should only have 1 account marked isHubPool as true");
    }
  }
}
