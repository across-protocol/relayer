import { CommonConfig, ProcessEnv } from "../common";
import { BigNumber, assert } from "../utils";

export class DataworkerConfig extends CommonConfig {
  readonly maxPoolRebalanceLeafSizeOverride: number;
  readonly maxRelayerRepaymentLeafSizeOverride: number;
  readonly tokenTransferThresholdOverride: { [l1TokenAddress: string]: BigNumber };

  constructor(env: ProcessEnv) {
    const {
      TOKEN_TRANSFER_THRESHOLD_OVERRIDE,
      MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE,
      MAX_RELAYER_REPAYMENT_LEAF_SIZE_OVERRIDE,
    } = env;
    super(env);

    // Should we assert that the leaf count caps are > 0?
    this.maxPoolRebalanceLeafSizeOverride = MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE
      ? Number(MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE)
      : undefined;
    if (this.maxPoolRebalanceLeafSizeOverride !== undefined)
      assert(this.maxPoolRebalanceLeafSizeOverride > 0, "Max leaf count set to 0");
    this.maxRelayerRepaymentLeafSizeOverride = MAX_RELAYER_REPAYMENT_LEAF_SIZE_OVERRIDE
      ? Number(MAX_RELAYER_REPAYMENT_LEAF_SIZE_OVERRIDE)
      : undefined;
    if (this.maxRelayerRepaymentLeafSizeOverride !== undefined)
      assert(this.maxRelayerRepaymentLeafSizeOverride > 0, "Max leaf count set to 0");
    this.tokenTransferThresholdOverride = TOKEN_TRANSFER_THRESHOLD_OVERRIDE
      ? JSON.parse(TOKEN_TRANSFER_THRESHOLD_OVERRIDE)
      : {};
  }
}
