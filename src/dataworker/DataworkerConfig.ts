import { CommonConfig, ProcessEnv } from "../common";
import { BigNumber, assert, getArweaveJWKSigner, toBNWei } from "../utils";

export class DataworkerConfig extends CommonConfig {
  readonly maxPoolRebalanceLeafSizeOverride: number;
  readonly maxRelayerRepaymentLeafSizeOverride: number;
  readonly rootBundleExecutionThreshold: BigNumber;
  readonly spokeRootsLookbackCount: number; // Consider making this configurable per chain ID.

  // These variables can be toggled to choose whether the bot will go through the dataworker logic.
  readonly disputerEnabled: boolean;
  readonly proposerEnabled: boolean;
  readonly l2ExecutorEnabled: boolean;
  readonly l1ExecutorEnabled: boolean;
  readonly finalizerEnabled: boolean;

  // This variable can be toggled to bypass the proposer logic and always attempt to propose
  // a bundle. This is useful for testing the disputer logic.
  readonly forcePropose: boolean;

  // This variable can be used to simulate a bundle range that a proposal will be created for.
  // This is useful for testing the disputer and proposer logic. The format is:
  // [number, number][] where the two numbers are the start and end bundle ranges and the array
  // represents the bundle ranges that will be proposed per the chain id indices.
  readonly forceProposalBundleRange?: [number, number][];

  // This variable should be set if the user wants to persist bundle data to Arweave.
  readonly persistingBundleData: boolean;

  // These variables allow the user to optimize dataworker run-time, which can slow down drastically because of all the
  // historical events it needs to fetch and parse.
  readonly dataworkerFastLookbackCount: number;
  readonly dataworkerFastStartBundle: number | string;

  readonly bufferToPropose: number;

  constructor(env: ProcessEnv) {
    const {
      ROOT_BUNDLE_EXECUTION_THRESHOLD,
      MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE,
      MAX_RELAYER_REPAYMENT_LEAF_SIZE_OVERRIDE,
      DISPUTER_ENABLED,
      PROPOSER_ENABLED,
      L2_EXECUTOR_ENABLED,
      L1_EXECUTOR_ENABLED,
      SPOKE_ROOTS_LOOKBACK_COUNT,
      FINALIZER_ENABLED,
      BUFFER_TO_PROPOSE,
      DATAWORKER_FAST_LOOKBACK_COUNT,
      DATAWORKER_FAST_START_BUNDLE,
      FORCE_PROPOSAL,
      FORCE_PROPOSAL_BUNDLE_RANGE,
      PERSIST_BUNDLES_TO_ARWEAVE,
    } = env;
    super(env);

    this.bufferToPropose = BUFFER_TO_PROPOSE ? Number(BUFFER_TO_PROPOSE) : (20 * 60) / 15; // 20 mins of blocks;
    // Should we assert that the leaf count caps are > 0?
    this.maxPoolRebalanceLeafSizeOverride = MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE
      ? Number(MAX_POOL_REBALANCE_LEAF_SIZE_OVERRIDE)
      : undefined;
    this.spokeRootsLookbackCount = SPOKE_ROOTS_LOOKBACK_COUNT ? Number(SPOKE_ROOTS_LOOKBACK_COUNT) : undefined;
    if (this.maxPoolRebalanceLeafSizeOverride !== undefined) {
      assert(this.maxPoolRebalanceLeafSizeOverride > 0, "Max leaf count set to 0");
    }
    this.maxRelayerRepaymentLeafSizeOverride = MAX_RELAYER_REPAYMENT_LEAF_SIZE_OVERRIDE
      ? Number(MAX_RELAYER_REPAYMENT_LEAF_SIZE_OVERRIDE)
      : undefined;
    if (this.maxRelayerRepaymentLeafSizeOverride !== undefined) {
      assert(this.maxRelayerRepaymentLeafSizeOverride > 0, "Max leaf count set to 0");
    }
    this.rootBundleExecutionThreshold = ROOT_BUNDLE_EXECUTION_THRESHOLD
      ? toBNWei(ROOT_BUNDLE_EXECUTION_THRESHOLD)
      : toBNWei("500000");
    this.disputerEnabled = DISPUTER_ENABLED === "true";
    this.proposerEnabled = PROPOSER_ENABLED === "true";
    this.l2ExecutorEnabled = L2_EXECUTOR_ENABLED === "true";
    this.l1ExecutorEnabled = L1_EXECUTOR_ENABLED === "true";
    if (this.l2ExecutorEnabled) {
      assert(this.spokeRootsLookbackCount > 0, "must set spokeRootsLookbackCount > 0 if L2 executor enabled");
    } else if (this.disputerEnabled || this.proposerEnabled) {
      // should set spokeRootsLookbackCount == 0 if executor disabled and proposer/disputer enabled
      this.spokeRootsLookbackCount = 0;
    }
    this.finalizerEnabled = FINALIZER_ENABLED === "true";

    this.forcePropose = FORCE_PROPOSAL === "true";

    // If FORCE_PROPOSAL_BUNDLE_RANGE is set, then we want to force a specific bundle range.
    if (FORCE_PROPOSAL_BUNDLE_RANGE) {
      // The format is [number, number][] where the two numbers are the start and end bundle ranges and the array
      // represents the bundle ranges that will be proposed per the chain id indices.
      this.forceProposalBundleRange = JSON.parse(FORCE_PROPOSAL_BUNDLE_RANGE);
      // We need to ensure that the bundle ranges are valid. A valid bundle range
      // is an array of [start, end] where both start and end are numeric and
      // positive whole numbers and start < end.
      this.forceProposalBundleRange.forEach((bundleRange, index) => {
        assert(Array.isArray(bundleRange), `forceProposalBundleRange[${index}] is not an array`);
        assert(bundleRange.length === 2, `forceProposalBundleRange[${index}] does not have length 2`);
        const [start, end] = bundleRange;
        assert(
          typeof start === "number" && Number.isInteger(start),
          `forceProposalBundleRange[${index}][start] is not a number`
        );
        assert(
          typeof end === "number" && Number.isInteger(end),
          `forceProposalBundleRange[${index}][end] is not a number`
        );
        assert(start >= 0, `forceProposalBundleRange[${index}][start] is not non-negative`);
        assert(end >= 0, `forceProposalBundleRange[${index}][end] is not non-negative`);
        assert(start <= end, `forceProposalBundleRange[${index}][start] >= forceProposalBundleRange[${index}][end]`);
      });
    } else {
      // If FORCE_PROPOSAL_BUNDLE_RANGE is not set, then we don't want to force a specific bundle range.
      this.forceProposalBundleRange = undefined;
    }

    // We NEVER want to force propose if the proposer is enabled.
    if (this.sendingTransactionsEnabled) {
      assert(!this.forcePropose, "Cannot force propose if sending proposals is enabled");
    }

    // `dataworkerFastLookbackCount` affects how far we fetch events from, modifying the search config's 'fromBlock'.
    // Set to 0 to load all events, but be careful as this will cause the Dataworker to take 30+ minutes to complete.
    // The average bundle frequency is 4-6 bundles per day so 16 bundles is a reasonable default
    // to lookback 2-4 days.
    this.dataworkerFastLookbackCount = DATAWORKER_FAST_LOOKBACK_COUNT
      ? Math.floor(Number(DATAWORKER_FAST_LOOKBACK_COUNT))
      : 16;
    assert(this.dataworkerFastLookbackCount > 0, "dataworkerFastLookbackCount should be > 0");
    if (this.spokeRootsLookbackCount !== undefined) {
      assert(
        this.dataworkerFastLookbackCount >= this.spokeRootsLookbackCount,
        "dataworkerFastLookbackCount should be >= spokeRootsLookbackCount"
      );
    }

    this.dataworkerFastStartBundle = DATAWORKER_FAST_START_BUNDLE ? Number(DATAWORKER_FAST_START_BUNDLE) : "latest";
    if (typeof this.dataworkerFastStartBundle === "number") {
      assert(
        this.dataworkerFastStartBundle > 0,
        `dataworkerFastStartBundle=${this.dataworkerFastStartBundle} should be > 0`
      );
      assert(
        this.dataworkerFastStartBundle >= this.dataworkerFastLookbackCount,
        `dataworkerFastStartBundle=${this.dataworkerFastStartBundle} should be >= dataworkerFastLookbackCount=${this.dataworkerFastLookbackCount}`
      );
    }
    this.persistingBundleData = PERSIST_BUNDLES_TO_ARWEAVE === "true";
    if (this.persistingBundleData) {
      // Call the getArweaveSigner function and allow it to throw if the ARWEAVE_WALLET_JWK is not set.
      getArweaveJWKSigner({ keyType: "read-write" });
    }
  }
}
