import { typeguards } from "@across-protocol/sdk";
import { CommonConfig, ProcessEnv } from "../common";
import { assert, BigNumber, isDefined, readFileSync } from "../utils";
import { TargetBalanceConfig } from "./rebalancer";

export class RebalancerConfig extends CommonConfig {
  public targetBalances: TargetBalanceConfig;
  public maxAmountsToTransfer: { [token: string]: { [sourceChainId: number]: BigNumber } };
  public chainIds: number[];
  // @todo for testing, allow config variables to be passed in as constructor arguments. In production,
  // we should read these from the environment variables.
  constructor(
    env: ProcessEnv,
    _targetBalances: TargetBalanceConfig,
    _maxAmountsToTransfer: { [token: string]: { [sourceChainId: number]: BigNumber } } = {}
  ) {
    const { REBALANCER_CONFIG, REBALANCER_EXTERNAL_CONFIG } = env;
    super(env);
    this.targetBalances = _targetBalances;
    this.maxAmountsToTransfer = _maxAmountsToTransfer;

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

    if (Object.keys(rebalancerConfig).length > 0) {
      // Set target balances
      // Set max amounts to transfer
      // Set chain ID's
    }
  }
}
