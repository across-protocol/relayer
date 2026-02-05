import { CommonConfig, ProcessEnv } from "../common";
import { BigNumber } from "../utils";
import { TargetBalanceConfig } from "./rebalancer";

export class RebalancerConfig extends CommonConfig {
  public targetBalances: TargetBalanceConfig;
  public maxAmountsToTransfer: { [token: string]: { [sourceChainId: number]: BigNumber } };
  // @todo for testing, allow config variables to be passed in as constructor arguments. In production,
  // we should read these from the environment variables.
  constructor(
    env: ProcessEnv,
    _targetBalances: TargetBalanceConfig,
    _maxAmountsToTransfer: { [token: string]: { [sourceChainId: number]: BigNumber } } = {}
  ) {
    super(env);
    this.targetBalances = _targetBalances;
    this.maxAmountsToTransfer = _maxAmountsToTransfer;
  }
}
