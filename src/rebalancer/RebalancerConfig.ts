import { CommonConfig, ProcessEnv } from "../common";
import { TargetBalanceConfig } from "./rebalancer";

export class RebalancerConfig extends CommonConfig {
  // @todo for testing, allow target balances to be passed in as a constructor argument.
  constructor(env: ProcessEnv, readonly targetBalances: TargetBalanceConfig) {
    super(env);
  }
}
