import { CommonConfig, ProcessEnv, BUNDLE_END_BLOCK_BUFFERS } from "../common";
import { BigNumber, assert } from "../utils";

export class DataworkerConfig extends CommonConfig {
  readonly maxPoolRebalanceLeafSizeOverride: number;
  readonly maxRelayerRepaymentLeafSizeOverride: number;
  readonly tokenTransferThresholdOverride: { [l1TokenAddress: string]: BigNumber };
  readonly blockRangeEndBlockBuffer: { [chainId: number]: number };

  constructor(env: ProcessEnv) {
    const {
      TOKEN_TRANSFER_THRESHOLD_OVERRIDE,
      MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE,
      MAX_RELAYER_REPAYMENT_LEAF_SIZE_OVERRIDE,
      BLOCK_RANGE_END_BLOCK_BUFFER,
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
    this.blockRangeEndBlockBuffer = BLOCK_RANGE_END_BLOCK_BUFFER
      ? JSON.parse(BLOCK_RANGE_END_BLOCK_BUFFER)
      : BUNDLE_END_BLOCK_BUFFERS;
    if (Object.keys(this.blockRangeEndBlockBuffer).length > 0)
      for (const chainId of this.spokePoolChains)
        assert(
          Object.keys(this.blockRangeEndBlockBuffer).includes(chainId.toString()),
          "BLOCK_RANGE_END_BLOCK_BUFFER missing networks"
        );
  }
}
