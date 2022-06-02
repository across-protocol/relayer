import { CommonConfig, ProcessEnv, BUNDLE_END_BLOCK_BUFFERS, CHAIN_ID_LIST_INDICES } from "../common";
import { BigNumber, assert, toBNWei } from "../utils";

export class DataworkerConfig extends CommonConfig {
  readonly maxPoolRebalanceLeafSizeOverride: number;
  readonly maxRelayerRepaymentLeafSizeOverride: number;
  readonly tokenTransferThresholdOverride: { [l1TokenAddress: string]: BigNumber };
  readonly blockRangeEndBlockBuffer: { [chainId: number]: number };
  readonly rootBundleExecutionThreshold: BigNumber;
  readonly disputerEnabled: boolean;
  readonly proposerEnabled: boolean;
  readonly executorEnabled: boolean;
  readonly spokeRootsLookbackCount: number; // Consider making this configurable per chain ID.
  readonly sendingDisputesEnabled: boolean;
  readonly finalizerChains: number[];
  readonly finalizerEnabled: boolean;

  constructor(env: ProcessEnv) {
    const {
      ROOT_BUNDLE_EXECUTION_THRESHOLD,
      TOKEN_TRANSFER_THRESHOLD_OVERRIDE,
      MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE,
      MAX_RELAYER_REPAYMENT_LEAF_SIZE_OVERRIDE,
      BLOCK_RANGE_END_BLOCK_BUFFER,
      DISPUTER_ENABLED,
      PROPOSER_ENABLED,
      EXECUTOR_ENABLED,
      SPOKE_ROOTS_LOOKBACK_COUNT,
      SEND_DISPUTES,
      FINALIZER_CHAINS,
      FINALIZER_ENABLED,
    } = env;
    super(env);

    // Should we assert that the leaf count caps are > 0?
    this.maxPoolRebalanceLeafSizeOverride = MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE
      ? Number(MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE)
      : undefined;
    this.spokeRootsLookbackCount = SPOKE_ROOTS_LOOKBACK_COUNT ? Number(SPOKE_ROOTS_LOOKBACK_COUNT) : undefined;
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
    this.rootBundleExecutionThreshold = ROOT_BUNDLE_EXECUTION_THRESHOLD
      ? toBNWei(ROOT_BUNDLE_EXECUTION_THRESHOLD)
      : toBNWei("500000");
    this.blockRangeEndBlockBuffer = BLOCK_RANGE_END_BLOCK_BUFFER
      ? JSON.parse(BLOCK_RANGE_END_BLOCK_BUFFER)
      : BUNDLE_END_BLOCK_BUFFERS;
    this.disputerEnabled = DISPUTER_ENABLED === "true";
    this.proposerEnabled = PROPOSER_ENABLED === "true";
    this.executorEnabled = EXECUTOR_ENABLED === "true";
    if (Object.keys(this.blockRangeEndBlockBuffer).length > 0)
      for (const chainId of this.spokePoolChains)
        assert(
          Object.keys(this.blockRangeEndBlockBuffer).includes(chainId.toString()),
          "BLOCK_RANGE_END_BLOCK_BUFFER missing networks"
        );
    this.sendingDisputesEnabled = SEND_DISPUTES === "true";
    this.finalizerChains = FINALIZER_CHAINS ? JSON.parse(FINALIZER_CHAINS) : CHAIN_ID_LIST_INDICES;
    this.finalizerEnabled = FINALIZER_ENABLED === "true";
  }
}
