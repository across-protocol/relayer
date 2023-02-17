import {
  winston,
  EMPTY_MERKLE_ROOT,
  sortEventsDescending,
  BigNumber,
  getRefund,
  MerkleTree,
  toBN,
  sortEventsAscending,
  isKeyOf,
  isDefined,
} from "../utils";
import { toBNWei, getFillsInRange, ZERO_ADDRESS } from "../utils";
import {
  DepositWithBlock,
  FillsToRefund,
  FillWithBlock,
  ProposedRootBundle,
  RootBundleRelayWithBlock,
  SpokePoolClientsByChain,
  UnfilledDeposit,
} from "../interfaces";
import {
  PendingRootBundle,
  TreeData,
  RunningBalances,
  PoolRebalanceLeaf,
  RelayerRefundLeaf,
  BigNumberForToken,
  RelayData,
} from "../interfaces";
import { DataworkerClients, spokePoolClientsToProviders } from "./DataworkerClientHelper";
import { SpokePoolClient } from "../clients";
import * as PoolRebalanceUtils from "./PoolRebalanceUtils";
import { blockRangesAreInvalidForSpokeClients, getBlockRangeForChain } from "../dataworker/DataworkerUtils";
import {
  getEndBlockBuffers,
  _buildPoolRebalanceRoot,
  _buildRelayerRefundRoot,
  _buildSlowRelayRoot,
} from "./DataworkerUtils";
import { BalanceAllocator } from "../clients";
import _ from "lodash";
import { CONFIG_STORE_VERSION, IGNORED_SPOKE_BUNDLES } from "../common";
import { isOvmChain, ovmWethTokens } from "../clients/bridges";

// Internal error reasons for labeling a pending root bundle as "invalid" that we don't want to submit a dispute
// for. These errors are due to issues with the dataworker configuration, instead of with the pending root
// bundle. Any reasons in IGNORE_X we emit a "debug" level log for, and any reasons in ERROR_X we emit an "error"
// level log for.
const IGNORE_DISPUTE_REASONS = new Set(["bundle-end-block-buffer"]);
const ERROR_DISPUTE_REASONS = new Set(["insufficient-dataworker-lookback", "out-of-date-config-store-version"]);

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  rootCache: {
    [key: string]: {
      runningBalances: RunningBalances;
      realizedLpFees: RunningBalances;
      leaves: PoolRebalanceLeaf[];
      tree: MerkleTree<PoolRebalanceLeaf>;
    };
  } = {};

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: DataworkerClients,
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly maxRefundCountOverride: number | undefined,
    readonly maxL1TokenCountOverride: number | undefined,
    readonly tokenTransferThreshold: BigNumberForToken = {},
    readonly blockRangeEndBlockBuffer: { [chainId: number]: number } = {},
    readonly spokeRootsLookbackCount = 0,
    readonly bufferToPropose = 0
  ) {
    if (
      maxRefundCountOverride !== undefined ||
      maxL1TokenCountOverride !== undefined ||
      Object.keys(tokenTransferThreshold).length > 0 ||
      Object.keys(blockRangeEndBlockBuffer).length > 0
    )
      this.logger.debug({
        at: "Dataworker constructed with overridden config store settings",
        maxRefundCountOverride: this.maxRefundCountOverride,
        maxL1TokenCountOverride: this.maxL1TokenCountOverride,
        tokenTransferThreshold: this.tokenTransferThreshold,
        blockRangeEndBlockBuffer: this.blockRangeEndBlockBuffer,
      });
  }

  // This should be called whenever it's possible that the loadData information for a block range could have changed.
  // For instance, if the spoke or hub clients have been updated, it probably makes sense to clear this to be safe.
  clearCache() {
    this.clients.bundleDataClient.clearCache();
    this.rootCache = {};
  }

  async buildSlowRelayRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    const { unfilledDeposits } = await this.clients.bundleDataClient.loadData(blockRangesForChains, spokePoolClients);
    return _buildSlowRelayRoot(unfilledDeposits);
  }

  async buildRelayerRefundRoot(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    poolRebalanceLeaves: PoolRebalanceLeaf[],
    runningBalances: RunningBalances
  ) {
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForChains,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    const { fillsToRefund } = await this.clients.bundleDataClient.loadData(blockRangesForChains, spokePoolClients);
    const maxRefundCount = this.maxRefundCountOverride
      ? this.maxRefundCountOverride
      : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
    return _buildRelayerRefundRoot(
      endBlockForMainnet,
      fillsToRefund,
      poolRebalanceLeaves,
      runningBalances,
      this.clients,
      maxRefundCount,
      this.tokenTransferThreshold
    );
  }

  // This method is only used in testing and scripts, not to propose new bundles.
  async buildPoolRebalanceRoot(
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain,
    latestMainnetBlock?: number
  ) {
    const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = await this.clients.bundleDataClient.loadData(
      blockRangesForChains,
      spokePoolClients
    );

    const mainnetBundleEndBlock = getBlockRangeForChain(
      blockRangesForChains,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesForChains,
      this.chainIdListForBundleEvaluationBlockNumbers
    );

    return await this._getPoolRebalanceRoot(
      spokePoolClients,
      blockRangesForChains,
      latestMainnetBlock ?? mainnetBundleEndBlock,
      mainnetBundleEndBlock,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      true
    );
  }

  shouldWaitToPropose(
    mainnetBundleEndBlock: number,
    bufferToPropose: number = this.bufferToPropose
  ): { shouldWait: boolean; [key: string]: unknown } {
    // Wait until all pool rebalance leaf executions from previous bundle are older than the new mainnet
    // bundle end block. This avoids any complications where a bundle is unable to determine the most recently
    // validated bundle. The HubPoolClient treats a bundle as "validated" once all of its pool rebalance leaves
    // are executed so we want to make sure that these are all older than the mainnet bundle end block which is
    // sometimes treated as the "latest" mainnet block.
    const mostRecentProposedRootBundle = this.clients.hubPoolClient.getLatestProposedRootBundle();

    // If there has never been a validated root bundle, then we can always propose a new one:
    if (mostRecentProposedRootBundle === undefined) {
      return {
        shouldWait: false,
      };
    }

    // Look for any executed leaves up to mainnet bundle end block. If they have been executed but they are not later
    // than the mainnet bundle end block, then we won't see them and we should wait.
    const executedPoolRebalanceLeaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(
      mostRecentProposedRootBundle,
      mainnetBundleEndBlock
    );
    const expectedPoolRebalanceLeaves = mostRecentProposedRootBundle.poolRebalanceLeafCount;
    if (expectedPoolRebalanceLeaves === 0) throw new Error("Pool rebalance leaf count must be > 0");
    const poolRebalanceLeafExecutionBlocks = executedPoolRebalanceLeaves.map((execution) => execution.blockNumber);

    // If any leaves are unexecuted, we should wait. This can also happen if the most recent proposed root bundle
    // was disputed or is still pending in the challenge period.
    if (expectedPoolRebalanceLeaves !== executedPoolRebalanceLeaves.length) {
      return {
        shouldWait: true,
        poolRebalanceLeafExecutionBlocks,
        mainnetBundleEndBlock,
        mostRecentProposedRootBundle: mostRecentProposedRootBundle.transactionHash,
        expectedPoolRebalanceLeaves,
        executedPoolRebalanceLeaves: executedPoolRebalanceLeaves.length,
      };
    }
    // We should now only wait if not enough time (e.g. the bufferToPropose # of seconds) has passed since the last
    // pool rebalance leaf was executed.
    else {
      // `poolRebalanceLeafExecutionBlocks` must have at least one element so the following computation will produce
      // a number.
      const latestExecutedPoolRebalanceLeafBlock = Math.max(...poolRebalanceLeafExecutionBlocks);
      const minimumMainnetBundleEndBlockToPropose = latestExecutedPoolRebalanceLeafBlock + bufferToPropose;
      return {
        shouldWait: mainnetBundleEndBlock < minimumMainnetBundleEndBlockToPropose,
        bufferToPropose,
        poolRebalanceLeafExecutionBlocks,
        mainnetBundleEndBlock,
        minimumMainnetBundleEndBlockToPropose,
        mostRecentProposedRootBundle: mostRecentProposedRootBundle.transactionHash,
      };
    }
  }

  async proposeRootBundle(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    usdThresholdToSubmitNewBundle?: BigNumber,
    submitProposals = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ) {
    // TODO: Handle the case where we can't get event data or even blockchain data from any chain. This will require
    // some changes to override the bundle block range here, and _loadData to skip chains with zero block ranges.
    // For now, we assume that if one blockchain fails to return data, then this entire function will fail. This is a
    // safe strategy but could lead to new roots failing to be proposed until ALL networks are healthy.

    // Check if a bundle is pending.
    if (!this.clients.hubPoolClient.isUpdated || !this.clients.hubPoolClient.latestBlockNumber)
      throw new Error("HubPoolClient not updated");
    if (this.clients.hubPoolClient.hasPendingProposal()) {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "Has pending proposal, cannot propose",
      });
      return;
    }

    // If config store version isn't up to date, return early. This is a simple rule that is perhaps too aggressive
    // but the proposer role is a specialized one and the user should always be using updated software.
    if (!this.clients.configStoreClient.hasLatestConfigStoreVersion) {
      this.logger.warn({
        at: "Dataworker#propose",
        message: "Skipping proposal because missing updated ConfigStore version, are you using the latest code?",
        latestVersionSupported: CONFIG_STORE_VERSION,
        latestInConfigStore: this.clients.configStoreClient.getConfigStoreVersionForTimestamp(),
      });
      return;
    }

    // Construct a list of ending block ranges for each chain that we want to include
    // relay events for. The ending block numbers for these ranges will be added to a "bundleEvaluationBlockNumbers"
    // list, and the order of chain ID's is hardcoded in the ConfigStore client.
    const blockRangesForProposal = await PoolRebalanceUtils.getWidestPossibleExpectedBlockRange(
      this.chainIdListForBundleEvaluationBlockNumbers,
      spokePoolClients,
      getEndBlockBuffers(this.chainIdListForBundleEvaluationBlockNumbers, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockNumber
    );

    // Exit early if spoke pool clients don't have early enough event data to satisfy block ranges for the
    // potential proposal
    if (
      Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
      blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        blockRangesForProposal,
        this.chainIdListForBundleEvaluationBlockNumbers,
        earliestBlocksInSpokePoolClients
      )
    ) {
      this.logger.warn({
        at: "Dataworke#propose",
        message: "Cannot propose bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
        rootBundleRanges: blockRangesForProposal,
        earliestBlocksInSpokePoolClients,
        spokeClientsEventSearchConfigs: Object.fromEntries(
          Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
        ),
      });
      return;
    }

    const mainnetBundleEndBlock = getBlockRangeForChain(
      blockRangesForProposal,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    // Create roots using constructed block ranges.
    const timerStart = Date.now();
    const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = await this.clients.bundleDataClient.loadData(
      blockRangesForProposal,
      spokePoolClients
    );
    this.logger.debug({
      at: "Dataworker",
      message: `Time to load data from BundleDataClient: ${Date.now() - timerStart}ms`,
    });
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesForProposal,
      this.chainIdListForBundleEvaluationBlockNumbers
    );
    this.logger.debug({ at: "Dataworker", message: "Building pool rebalance root", blockRangesForProposal });
    const poolRebalanceRoot = await this._getPoolRebalanceRoot(
      spokePoolClients,
      blockRangesForProposal,
      this.clients.hubPoolClient.latestBlockNumber,
      mainnetBundleEndBlock,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      true
    );
    PoolRebalanceUtils.prettyPrintLeaves(
      this.logger,
      poolRebalanceRoot.tree,
      poolRebalanceRoot.leaves,
      "Pool rebalance"
    );

    if (usdThresholdToSubmitNewBundle !== undefined) {
      // Exit early if volume of pool rebalance leaves exceeds USD threshold. Volume includes netSendAmounts only since
      // that is the actual amount sent over bridges. This also mitigates the chance that a RelayerRefundLeaf is
      // published but its refund currency isn't sent over the bridge in a PoolRebalanceLeaf.
      const totalUsdRefund = PoolRebalanceUtils.computePoolRebalanceUsdVolume(poolRebalanceRoot.leaves, this.clients);
      if (totalUsdRefund.lt(usdThresholdToSubmitNewBundle)) {
        this.logger.debug({
          at: "Dataworker",
          message: "Root bundle USD volume does not exceed threshold, exiting early 🟡",
          usdThresholdToSubmitNewBundle,
          totalUsdRefund,
          leaves: poolRebalanceRoot.leaves,
        });
        return;
      } else
        this.logger.debug({
          at: "Dataworker",
          message: "Root bundle USD volume exceeds threshold! 💚",
          usdThresholdToSubmitNewBundle,
          totalUsdRefund,
        });
    }

    // TODO: Validate running balances in potential new bundle and make sure that important invariants
    // are not violated, such as a token balance being lower than the amount necessary to pay out all refunds,
    // slow fills, and return funds to the HubPool. Can use logic similar to /src/scripts/validateRunningbalances.ts

    const shouldWaitToPropose = this.shouldWaitToPropose(mainnetBundleEndBlock);
    if (shouldWaitToPropose.shouldWait) {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "Waiting to propose new bundle",
        shouldWaitToPropose,
      });
      return;
    } else
      this.logger.debug({
        at: "Dataworker#propose",
        message: "Proceeding to propose new bundle",
        shouldWaitToPropose,
      });

    this.logger.debug({ at: "Dataworker", message: "Building relayer refund root", blockRangesForProposal });
    const relayerRefundRoot = _buildRelayerRefundRoot(
      mainnetBundleEndBlock,
      fillsToRefund,
      poolRebalanceRoot.leaves,
      poolRebalanceRoot.runningBalances,
      this.clients,
      this.maxRefundCountOverride
        ? this.maxRefundCountOverride
        : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(mainnetBundleEndBlock),
      this.tokenTransferThreshold
    );
    PoolRebalanceUtils.prettyPrintLeaves(
      this.logger,
      relayerRefundRoot.tree,
      relayerRefundRoot.leaves,
      "Relayer refund"
    );
    this.logger.debug({ at: "Dataworker", message: "Building slow relay root", blockRangesForProposal });
    const slowRelayRoot = _buildSlowRelayRoot(unfilledDeposits);
    PoolRebalanceUtils.prettyPrintLeaves(this.logger, slowRelayRoot.tree, slowRelayRoot.leaves, "Slow relay");

    if (poolRebalanceRoot.leaves.length === 0) {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "No pool rebalance leaves, cannot propose",
      });
      return;
    }

    // 4. Propose roots to HubPool contract.
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;
    this.logger.debug({
      at: "Dataworker#propose",
      message: "Enqueing new root bundle proposal txn",
      blockRangesForProposal,
      poolRebalanceLeavesCount: poolRebalanceRoot.leaves.length,
      poolRebalanceRoot: poolRebalanceRoot.tree.getHexRoot(),
      relayerRefundRoot: relayerRefundRoot.tree.getHexRoot(),
      slowRelayRoot: slowRelayRoot.tree.getHexRoot(),
    });
    if (submitProposals)
      this._proposeRootBundle(
        hubPoolChainId,
        blockRangesForProposal,
        poolRebalanceRoot.leaves,
        poolRebalanceRoot.tree.getHexRoot(),
        relayerRefundRoot.leaves,
        relayerRefundRoot.tree.getHexRoot(),
        slowRelayRoot.leaves,
        slowRelayRoot.tree.getHexRoot()
      );
  }

  async validatePendingRootBundle(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    submitDisputes = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ) {
    if (
      !this.clients.hubPoolClient.isUpdated ||
      this.clients.hubPoolClient.currentTime === undefined ||
      this.clients.hubPoolClient.latestBlockNumber === undefined
    )
      throw new Error("HubPoolClient not updated");
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;

    // Exit early if a bundle is not pending.
    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundle();
    if (pendingRootBundle === undefined) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "No pending proposal, nothing to validate",
      });
      return;
    }

    this.logger.debug({
      at: "Dataworker#validate",
      message: "Found pending proposal",
      pendingRootBundle,
    });

    // Exit early if challenge period timestamp has passed:
    if (this.clients.hubPoolClient.currentTime > pendingRootBundle.challengePeriodEndTimestamp) {
      this.logger.debug({
        at: "Dataworke#validater",
        message: "Challenge period passed, cannot dispute",
        expirationTime: pendingRootBundle.challengePeriodEndTimestamp,
      });
      return;
    }

    const widestPossibleExpectedBlockRange = await PoolRebalanceUtils.getWidestPossibleExpectedBlockRange(
      this.chainIdListForBundleEvaluationBlockNumbers,
      spokePoolClients,
      getEndBlockBuffers(this.chainIdListForBundleEvaluationBlockNumbers, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockNumber
    );
    const { valid, reason } = await this.validateRootBundle(
      hubPoolChainId,
      widestPossibleExpectedBlockRange,
      pendingRootBundle,
      spokePoolClients,
      earliestBlocksInSpokePoolClients
    );
    if (!valid) {
      // In the case where the Dataworker config is improperly configured, emit an error level alert so bot runner
      // can get dataworker running ASAP.
      if (ERROR_DISPUTE_REASONS.has(reason)) {
        this.logger.error({
          at: "Dataworker#validate",
          message: "Skipping dispute because of dataworker configuration error that needs to be fixed",
          reason,
        });
      } else if (IGNORE_DISPUTE_REASONS.has(reason)) {
        this.logger.debug({
          at: "Dataworker#validate",
          message: "Skipping dispute because of dataworker configuration error, should resolve itself eventually 😪",
          reason,
        });
      } else {
        this.logger.error({
          at: "Dataworker",
          message: "Submitting dispute 🤏🏼",
          mrkdwn: reason,
        });
        if (submitDisputes) this._submitDisputeWithMrkdwn(hubPoolChainId, reason);
      }
    }
  }

  async validateRootBundle(
    hubPoolChainId: number,
    widestPossibleExpectedBlockRange: number[][],
    rootBundle: PendingRootBundle,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    earliestBlocksInSpokePoolClients: { [chainId: number]: number }
  ): Promise<
    // If valid is false, we get a reason and we might get expected trees.
    | {
        valid: false;
        reason: string;
        expectedTrees?: {
          poolRebalanceTree: TreeData<PoolRebalanceLeaf>;
          relayerRefundTree: TreeData<RelayerRefundLeaf>;
          slowRelayTree: TreeData<RelayData>;
        };
      }
    // If valid is true, we don't get a reason, and we always get expected trees.
    | {
        valid: true;
        reason: undefined;
        expectedTrees: {
          poolRebalanceTree: TreeData<PoolRebalanceLeaf>;
          relayerRefundTree: TreeData<RelayerRefundLeaf>;
          slowRelayTree: TreeData<RelayData>;
        };
      }
  > {
    // If pool rebalance root is empty, always dispute. There should never be a bundle with an empty rebalance root.
    if (rootBundle.poolRebalanceRoot === EMPTY_MERKLE_ROOT) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Empty pool rebalance root, submitting dispute",
        rootBundle,
      });
      return {
        valid: false,
        reason: "Disputed pending root bundle with empty pool rebalance root",
      };
    }

    // First, we'll evaluate the pending root bundle's block end numbers.
    if (rootBundle.bundleEvaluationBlockNumbers.length !== widestPossibleExpectedBlockRange.length) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected bundle block range length, disputing",
        widestPossibleExpectedBlockRange,
        pendingEndBlocks: rootBundle.bundleEvaluationBlockNumbers,
      });
      return {
        valid: false,
        reason: "Disputed pending root bundle with incorrect bundle block range length",
      };
    }

    const endBlockBuffers = getEndBlockBuffers(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.blockRangeEndBlockBuffer
    );

    // Make sure that all end blocks are >= expected start blocks.
    if (
      rootBundle.bundleEvaluationBlockNumbers.some((block, index) => block < widestPossibleExpectedBlockRange[index][0])
    ) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "A bundle end block is < expected start block, submitting dispute",
        expectedStartBlocks: widestPossibleExpectedBlockRange.map((range) => range[0]),
        pendingEndBlocks: rootBundle.bundleEvaluationBlockNumbers,
      });
      return {
        valid: false,
        reason: PoolRebalanceUtils.generateMarkdownForDisputeInvalidBundleBlocks(
          this.chainIdListForBundleEvaluationBlockNumbers,
          rootBundle,
          widestPossibleExpectedBlockRange,
          endBlockBuffers
        ),
      };
    }

    // If the bundle end block is less than HEAD but within the allowable margin of error into future,
    // then we won't dispute and we'll just exit early from this function.
    if (
      rootBundle.bundleEvaluationBlockNumbers.some((block, index) => block > widestPossibleExpectedBlockRange[index][1])
    ) {
      // If end block is further than the allowable margin of error into the future, then dispute it.
      if (
        rootBundle.bundleEvaluationBlockNumbers.some(
          (block, index) => block > widestPossibleExpectedBlockRange[index][1] + endBlockBuffers[index]
        )
      ) {
        this.logger.debug({
          at: "Dataworker#validate",
          message: "A bundle end block is > latest block + buffer for its chain, submitting dispute",
          expectedEndBlocks: widestPossibleExpectedBlockRange.map((range) => range[1]),
          pendingEndBlocks: rootBundle.bundleEvaluationBlockNumbers,
          endBlockBuffers,
        });
        return {
          valid: false,
          reason: PoolRebalanceUtils.generateMarkdownForDisputeInvalidBundleBlocks(
            this.chainIdListForBundleEvaluationBlockNumbers,
            rootBundle,
            widestPossibleExpectedBlockRange,
            endBlockBuffers
          ),
        };
      } else {
        this.logger.debug({
          at: "Dataworker#validate",
          message: "Cannot validate because a bundle end block is > latest block but within buffer",
          expectedEndBlocks: widestPossibleExpectedBlockRange.map((range) => range[1]),
          pendingEndBlocks: rootBundle.bundleEvaluationBlockNumbers,
          endBlockBuffers,
        });
      }
      return {
        valid: false,
        reason: "bundle-end-block-buffer",
      };
    }

    // The block range that we'll use to construct roots will be the end block specified in the pending root bundle,
    // and the block right after the last valid root bundle proposal's end block. If the proposer didn't use the same
    // start block, then they might have missed events and the roots will be different.
    const blockRangesImpliedByBundleEndBlocks = widestPossibleExpectedBlockRange.map((blockRange, index) => [
      blockRange[0],
      rootBundle.bundleEvaluationBlockNumbers[index],
    ]);

    // Exit early if spoke pool clients don't have early enough event data to satisfy block ranges for the
    // pending proposal. Log an error loudly so that user knows that disputer needs to increase its lookback.
    if (
      Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
      blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        blockRangesImpliedByBundleEndBlocks,
        this.chainIdListForBundleEvaluationBlockNumbers,
        earliestBlocksInSpokePoolClients
      )
    ) {
      this.logger.debug({
        at: "Dataworke#validate",
        message: "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
        rootBundleRanges: blockRangesImpliedByBundleEndBlocks,
        earliestBlocksInSpokePoolClients,
        spokeClientsEventSearchConfigs: Object.fromEntries(
          Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
        ),
      });
      return {
        valid: false,
        reason: "insufficient-dataworker-lookback",
      };
    }

    this.logger.debug({
      at: "Dataworker#validate",
      message: "Implied bundle ranges are valid",
      blockRangesImpliedByBundleEndBlocks,
      chainIdListForBundleEvaluationBlockNumbers: this.chainIdListForBundleEvaluationBlockNumbers,
    });

    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesImpliedByBundleEndBlocks,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];
    // If config store version isn't up to date, return early. This is a simple rule that is perhaps too aggressive
    // but the proposer role is a specialized one and the user should always be using updated software.
    if (!this.clients.configStoreClient.hasLatestConfigStoreVersion) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Cannot validate because missing updated ConfigStore version. Update to latest code.",
        latestVersionSupported: CONFIG_STORE_VERSION,
        latestInConfigStore: this.clients.configStoreClient.getConfigStoreVersionForTimestamp(),
      });
      return {
        valid: false,
        reason: "out-of-date-config-store-version",
      };
    }

    // Compare roots with expected. The roots will be different if the block range start blocks were different
    // than the ones we constructed above when the original proposer submitted their proposal. The roots will also
    // be different if the events on any of the contracts were different.
    const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = await this.clients.bundleDataClient.loadData(
      blockRangesImpliedByBundleEndBlocks,
      spokePoolClients
    );
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesImpliedByBundleEndBlocks,
      this.chainIdListForBundleEvaluationBlockNumbers
    );
    const expectedPoolRebalanceRoot = await this._getPoolRebalanceRoot(
      spokePoolClients,
      blockRangesImpliedByBundleEndBlocks,
      rootBundle.proposalBlockNumber,
      endBlockForMainnet,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      true
    );
    const expectedRelayerRefundRoot = _buildRelayerRefundRoot(
      endBlockForMainnet,
      fillsToRefund,
      expectedPoolRebalanceRoot.leaves,
      expectedPoolRebalanceRoot.runningBalances,
      this.clients,
      this.maxRefundCountOverride
        ? this.maxRefundCountOverride
        : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet),
      this.tokenTransferThreshold
    );

    const expectedSlowRelayRoot = _buildSlowRelayRoot(unfilledDeposits);

    const expectedTrees = {
      poolRebalanceTree: expectedPoolRebalanceRoot,
      relayerRefundTree: expectedRelayerRefundRoot,
      slowRelayTree: expectedSlowRelayRoot,
    };
    if (
      // Its ok if there are fewer unclaimed leaves than in the reconstructed root, because some of the leaves
      // might already have been executed, but its an issue if the reconstructed root expects fewer leaves than there
      // are left to execute because it means that the unclaimed count can never drop to 0.
      expectedPoolRebalanceRoot.leaves.length < rootBundle.unclaimedPoolRebalanceLeafCount ||
      expectedPoolRebalanceRoot.tree.getHexRoot() !== rootBundle.poolRebalanceRoot
    ) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected pool rebalance root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedPoolRebalanceLeaves: expectedPoolRebalanceRoot.leaves,
        expectedPoolRebalanceRoot: expectedPoolRebalanceRoot.tree.getHexRoot(),
        expectedRelayerRefundLeaves: expectedRelayerRefundRoot.leaves,
        expectedRelayerRefundRoot: expectedRelayerRefundRoot.tree.getHexRoot(),
        expectedSlowRelayLeaves: expectedSlowRelayRoot.leaves,
        expectedSlowRelayRoot: expectedSlowRelayRoot.tree.getHexRoot(),
        pendingRoot: rootBundle.poolRebalanceRoot,
        pendingPoolRebalanceLeafCount: rootBundle.unclaimedPoolRebalanceLeafCount,
      });
    } else if (expectedRelayerRefundRoot.tree.getHexRoot() !== rootBundle.relayerRefundRoot) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected relayer refund root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedRelayerRefundRoot: expectedRelayerRefundRoot.tree.getHexRoot(),
        pendingRoot: rootBundle.relayerRefundRoot,
      });
    } else if (expectedSlowRelayRoot.tree.getHexRoot() !== rootBundle.slowRelayRoot) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected slow relay root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedSlowRelayRoot: expectedSlowRelayRoot.tree.getHexRoot(),
        pendingRoot: rootBundle.slowRelayRoot,
      });
    } else {
      // All roots are valid! Exit early.
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Pending root bundle matches with expected",
      });
      return {
        valid: true,
        expectedTrees,
        reason: undefined,
      };
    }

    return {
      valid: false,
      reason:
        PoolRebalanceUtils.generateMarkdownForDispute(rootBundle) +
        "\n" +
        PoolRebalanceUtils.generateMarkdownForRootBundle(
          this.clients.hubPoolClient,
          this.chainIdListForBundleEvaluationBlockNumbers,
          hubPoolChainId,
          blockRangesImpliedByBundleEndBlocks,
          [...expectedPoolRebalanceRoot.leaves],
          expectedPoolRebalanceRoot.tree.getHexRoot(),
          [...expectedRelayerRefundRoot.leaves],
          expectedRelayerRefundRoot.tree.getHexRoot(),
          [...expectedSlowRelayRoot.leaves],
          expectedSlowRelayRoot.tree.getHexRoot()
        ),
      expectedTrees,
    };
  }

  // TODO: this method and executeRelayerRefundLeaves have a lot of similarities, but they have some key differences
  // in both the events they search for and the comparisons they make. We should try to generalize this in the future,
  // but keeping them separate is probably the simplest for the initial implementation.
  async executeSlowRelayLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients)),
    submitExecution = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ) {
    this.logger.debug({
      at: "Dataworker#executeSlowRelayLeaves",
      message: "Executing slow relay leaves",
    });

    let latestRootBundles = sortEventsDescending(this.clients.hubPoolClient.getValidatedRootBundles());
    if (this.spokeRootsLookbackCount !== 0) {
      latestRootBundles = latestRootBundles.slice(0, this.spokeRootsLookbackCount);
    }

    await Promise.all(
      Object.entries(spokePoolClients).map(async ([_chainId, client]) => {
        const chainId = Number(_chainId);
        let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter((rootBundle) =>
          isKeyOf(chainId, IGNORED_SPOKE_BUNDLES)
            ? !IGNORED_SPOKE_BUNDLES[chainId].includes(rootBundle.rootBundleId)
            : rootBundle.blockNumber >= client.eventSearchConfig.fromBlock
        );

        // Filter out roots that are not in the latest N root bundles. This assumes that
        // relayerRefundRoot+slowFillRoot combinations are unique.
        rootBundleRelays = this._getRelayedRootsFromBundles(latestRootBundles, rootBundleRelays);

        // Filter out empty slow fill roots:
        rootBundleRelays = rootBundleRelays.filter((rootBundle) => rootBundle.slowRelayRoot !== EMPTY_MERKLE_ROOT);

        this.logger.debug({
          at: "Dataworker#executeSlowRelayLeaves",
          message: `Evaluating ${rootBundleRelays.length} historical non-empty slow roots relayed to chain ${chainId}`,
        });

        const sortedFills = client.getFills();

        const slowFillsForChain = client.getFills().filter((fill) => fill.isSlowRelay);
        for (const rootBundleRelay of sortEventsAscending(rootBundleRelays)) {
          const matchingRootBundle = this.clients.hubPoolClient.getProposedRootBundles().find((bundle) => {
            if (bundle.slowRelayRoot !== rootBundleRelay.slowRelayRoot) return false;

            const followingBlockNumber =
              this.clients.hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber ||
              this.clients.hubPoolClient.latestBlockNumber;

            if (!followingBlockNumber) return false;

            const leaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);

            // Only use this bundle if it had valid leaves returned (meaning it was at least partially executed).
            return leaves.length > 0;
          });

          if (!matchingRootBundle) {
            this.logger.warn({
              at: "Dataworke#executeSlowRelayLeaves",
              message: "Couldn't find a matching mainnet root bundle for a slowRelayRoot on L2!",
              chainId,
              slowRelayRoot: rootBundleRelay.slowRelayRoot,
              rootBundleId: rootBundleRelay.rootBundleId,
            });
            continue;
          }

          const prevRootBundle = this.clients.hubPoolClient.getLatestFullyExecutedRootBundle(
            matchingRootBundle.blockNumber
          );

          const blockNumberRanges = matchingRootBundle.bundleEvaluationBlockNumbers.map((endBlock, i) => {
            const fromBlock = prevRootBundle?.bundleEvaluationBlockNumbers?.[i]
              ? prevRootBundle.bundleEvaluationBlockNumbers[i].toNumber() + 1
              : 0;
            return [fromBlock, endBlock.toNumber()];
          });

          if (
            Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
            blockRangesAreInvalidForSpokeClients(
              spokePoolClients,
              blockNumberRanges,
              this.chainIdListForBundleEvaluationBlockNumbers,
              earliestBlocksInSpokePoolClients
            )
          ) {
            this.logger.warn({
              at: "Dataworke#executeSlowRelayLeaves",
              message:
                "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
              chainId,
              rootBundleRanges: blockNumberRanges,
              earliestBlocksInSpokePoolClients,
              spokeClientsEventSearchConfigs: Object.fromEntries(
                Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
              ),
            });
            continue;
          }

          const { unfilledDeposits } = await this.clients.bundleDataClient.loadData(
            blockNumberRanges,
            spokePoolClients,
            false // Don't log this function's result since we're calling it once per chain per root bundle
          );
          const { tree, leaves } = _buildSlowRelayRoot(unfilledDeposits);
          if (tree.getHexRoot() !== rootBundleRelay.slowRelayRoot) {
            this.logger.warn({
              at: "Dataworke#executeSlowRelayLeaves",
              message: "Constructed a different root for the block range!",
              chainId,
              rootBundleRelay,
              mainnetRootBundleBlock: matchingRootBundle.blockNumber,
              mainnetRootBundleTxn: matchingRootBundle.transactionHash,
              publishedSlowRelayRoot: rootBundleRelay.slowRelayRoot,
              constructedSlowRelayRoot: tree.getHexRoot(),
            });
            continue;
          }

          const leavesForChain = leaves.filter((leaf) => leaf.destinationChainId === Number(chainId));
          const unexecutedLeaves = leavesForChain.filter((leaf) => {
            const executedLeaf = slowFillsForChain.find(
              (event) => event.originChainId === leaf.originChainId && event.depositId === leaf.depositId
            );

            // Only return true if no leaf was found in the list of executed leaves.
            return !executedLeaf;
          });
          if (unexecutedLeaves.length === 0) continue;

          const leavesWithLatestFills = unexecutedLeaves.map((leaf) => {
            // Start with the most recent fills and search backwards.
            const fill = _.findLast(sortedFills, (fill) => {
              return (
                fill.depositId === leaf.depositId &&
                fill.originChainId === leaf.originChainId &&
                fill.depositor === leaf.depositor &&
                fill.destinationChainId === leaf.destinationChainId &&
                fill.destinationToken === leaf.destinationToken &&
                fill.amount.eq(leaf.amount) &&
                fill.realizedLpFeePct.eq(leaf.realizedLpFeePct) &&
                fill.relayerFeePct.eq(leaf.relayerFeePct) &&
                fill.recipient === leaf.recipient
              );
            });

            return { ...leaf, fill };
          });

          // Filter for leaves where the contract has the funding to send the required tokens.
          const fundedLeaves = (
            await Promise.all(
              leavesWithLatestFills.map(async (leaf) => {
                // Check if fill was a full fill. If so, execution is unnecessary.
                if (leaf.fill && leaf.fill.totalFilledAmount.eq(leaf.fill.amount)) {
                  return undefined;
                }

                // If the most recent fill is not found, just make the most conservative assumption: a 0-sized fill.
                const amountFilled = leaf.fill ? leaf.fill.totalFilledAmount : BigNumber.from(0);

                // Note: the getRefund function just happens to perform the same math we need.
                // A refund is the total fill amount minus LP fees, which is the same as the payout for a slow relay!
                const amountRequired = getRefund(leaf.amount.sub(amountFilled), leaf.realizedLpFeePct);
                const success = await balanceAllocator.requestBalanceAllocation(
                  leaf.destinationChainId,
                  isOvmChain(leaf.destinationChainId) && ovmWethTokens.includes(leaf.destinationToken)
                    ? ovmWethTokens
                    : [leaf.destinationToken],
                  client.spokePool.address,
                  amountRequired
                );

                if (!success) {
                  this.logger.warn({
                    at: "Dataworker#executeSlowRelayLeaves",
                    message: "Not executing slow relay leaf due to lack of funds in SpokePool",
                    root: rootBundleRelay.slowRelayRoot,
                    bundle: rootBundleRelay.rootBundleId,
                    depositId: leaf.depositId,
                    fromChain: leaf.originChainId,
                    chainId: leaf.destinationChainId,
                    token: leaf.destinationToken,
                    amount: leaf.amount,
                  });
                }

                return success ? leaf : undefined;
              })
            )
          ).filter(isDefined);

          fundedLeaves.forEach((leaf) => {
            const mrkdwn = `rootBundleId: ${rootBundleRelay.rootBundleId}\nslowRelayRoot: ${
              rootBundleRelay.slowRelayRoot
            }\nOrigin chain: ${leaf.originChainId}\nDestination chain:${leaf.destinationChainId}\nDeposit Id: ${
              leaf.depositId
            }\namount: ${leaf.amount.toString()}`;
            if (submitExecution)
              this.clients.multiCallerClient.enqueueTransaction({
                contract: client.spokePool,
                chainId: Number(chainId),
                method: "executeSlowRelayLeaf",
                args: [
                  leaf.depositor,
                  leaf.recipient,
                  leaf.destinationToken,
                  leaf.amount,
                  leaf.originChainId,
                  leaf.realizedLpFeePct,
                  leaf.relayerFeePct,
                  leaf.depositId,
                  rootBundleRelay.rootBundleId,
                  tree.getHexProof(leaf),
                ],
                message: "Executed SlowRelayLeaf 🌿!",
                mrkdwn,
              });
            else this.logger.debug({ at: "Dataworker#executeSlowRelayLeaves", message: mrkdwn });
          });
        }
      })
    );
  }

  async executePoolRebalanceLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients)),
    submitExecution = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ) {
    this.logger.debug({
      at: "Dataworker#executePoolRebalanceLeaves",
      message: "Executing pool rebalance leaves",
    });

    if (
      !this.clients.hubPoolClient.isUpdated ||
      this.clients.hubPoolClient.currentTime === undefined ||
      this.clients.hubPoolClient.latestBlockNumber === undefined
    )
      throw new Error("HubPoolClient not updated");
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;

    // Exit early if a bundle is not pending.
    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundle();
    if (pendingRootBundle === undefined) {
      this.logger.debug({
        at: "Dataworker#executePoolRebalanceLeaves",
        message: "No pending proposal, nothing to execute",
      });
      return;
    }

    this.logger.debug({
      at: "Dataworker#executePoolRebalanceLeaves",
      message: "Found pending proposal",
      pendingRootBundle,
    });

    // Exit early if challenge period timestamp has not passed:
    if (this.clients.hubPoolClient.currentTime <= pendingRootBundle.challengePeriodEndTimestamp) {
      this.logger.debug({
        at: "Dataworke#executePoolRebalanceLeaves",
        message: `Challenge period not passed, cannot execute until ${pendingRootBundle.challengePeriodEndTimestamp}`,
        expirationTime: pendingRootBundle.challengePeriodEndTimestamp,
      });
      return;
    }

    const widestPossibleExpectedBlockRange = await PoolRebalanceUtils.getWidestPossibleExpectedBlockRange(
      this.chainIdListForBundleEvaluationBlockNumbers,
      spokePoolClients,
      getEndBlockBuffers(this.chainIdListForBundleEvaluationBlockNumbers, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockNumber
    );
    const { valid, reason, expectedTrees } = await this.validateRootBundle(
      hubPoolChainId,
      widestPossibleExpectedBlockRange,
      pendingRootBundle,
      spokePoolClients,
      earliestBlocksInSpokePoolClients
    );

    if (!valid) {
      this.logger.error({
        at: "Dataworke#executePoolRebalanceLeaves",
        message: "Found invalid proposal after challenge period!",
        reason,
        notificationPath: "across-error",
      });
      return;
    }

    if (valid && !expectedTrees) {
      this.logger.error({
        at: "Dataworke#executePoolRebalanceLeaves",
        message:
          "Found valid proposal, but no trees could be generated. This probably means that the proposal was never evaluated during liveness due to an odd block range!",
        reason,
        notificationPath: "across-error",
      });
      return;
    }

    const executedLeaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(
      this.clients.hubPoolClient.getLatestProposedRootBundle(),
      this.clients.hubPoolClient.latestBlockNumber
    );

    // Filter out previously executed leaves.
    const unexecutedLeaves = expectedTrees.poolRebalanceTree.leaves.filter((leaf) =>
      executedLeaves.every(({ leafId }) => leafId !== leaf.leafId)
    );
    if (unexecutedLeaves.length === 0) return;

    // Filter for leaves where the contract has the funding to send the required tokens.
    const fundedLeaves = (
      await Promise.all(
        unexecutedLeaves.map(async (leaf) => {
          const requests = leaf.netSendAmounts.map((amount, i) => ({
            amount: amount.gte(0) ? amount : BigNumber.from(0),
            tokens: [leaf.l1Tokens[i]],
            holder: this.clients.hubPoolClient.hubPool.address,
            chainId: hubPoolChainId,
          }));

          if (leaf.chainId === 42161) {
            const hubPoolBalance = await this.clients.hubPoolClient.hubPool.provider.getBalance(
              this.clients.hubPoolClient.hubPool.address
            );
            if (hubPoolBalance.lt(this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf)))
              requests.push({
                tokens: [ZERO_ADDRESS],
                amount: this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf),
                holder: await this.clients.spokePoolSigners[hubPoolChainId].getAddress(),
                chainId: hubPoolChainId,
              });
          }

          const success = await balanceAllocator.requestBalanceAllocations(requests);

          if (!success) {
            // Note: this is an error because the HubPool should generally not run out of funds to put into
            // netSendAmounts. This means that no new bundles can be proposed until this leaf is funded.
            this.logger.error({
              at: "Dataworker#executePoolRebalanceLeaves",
              message: "Not executing pool rebalance leaf on HubPool due to lack of funds to send.",
              root: expectedTrees.poolRebalanceTree.tree.getHexRoot(),
              leafId: leaf.leafId,
              rebalanceChain: leaf.chainId,
              chainId: hubPoolChainId,
              token: leaf.l1Tokens,
              netSendAmounts: leaf.netSendAmounts,
            });
          }
          return success ? leaf : undefined;
        })
      )
    ).filter(isDefined);

    // Call `exchangeRateCurrent` on the HubPool before accumulating fees from the executed bundle leaves. This is to
    // address the situation where `addLiquidity` and `removeLiquidity` have not been called for an L1 token for a
    // while, which are the other methods that trigger an internal call to `_exchangeRateCurrent()`. Calling
    // this method triggers a recompounding of fees before new fees come in.
    const compoundedFeesForL1Token: string[] = [];
    fundedLeaves.forEach((leaf) => {
      leaf.l1Tokens.forEach((l1Token, i) => {
        // Exit early if lp fees are 0
        if (leaf.bundleLpFees[i].eq(toBN(0))) return;

        // Exit early if we already compounded fees for this l1 token on this loop
        if (compoundedFeesForL1Token.includes(l1Token)) return;
        else compoundedFeesForL1Token.push(l1Token);

        // Exit early if we recently compounded fees
        const lastestFeesCompoundedTime =
          this.clients.hubPoolClient.getLpTokenInfoForL1Token(l1Token)?.lastLpFeeUpdate ?? 0;
        if (
          this.clients.hubPoolClient.currentTime === undefined ||
          this.clients.hubPoolClient.currentTime - lastestFeesCompoundedTime <= 86400
        )
          return;

        if (submitExecution) {
          this.clients.multiCallerClient.enqueueTransaction({
            contract: this.clients.hubPoolClient.hubPool,
            chainId: hubPoolChainId,
            method: "exchangeRateCurrent",
            args: [l1Token],
            message: "Updated exchange rate ♻️!",
            mrkdwn: `Updated exchange rate for l1 token: ${
              this.clients.hubPoolClient.getTokenInfo(1, l1Token)?.symbol
            }`,
          });
        }
      });
    });

    const hubPoolBalance = await this.clients.hubPoolClient.hubPool.provider.getBalance(
      this.clients.hubPoolClient.hubPool.address
    );
    fundedLeaves.forEach((leaf) => {
      const proof = expectedTrees.poolRebalanceTree.tree.getHexProof(leaf);
      const mrkdwn = `Root hash: ${expectedTrees.poolRebalanceTree.tree.getHexRoot()}\nLeaf: ${leaf.leafId}\nChain: ${
        leaf.chainId
      }`;
      if (submitExecution) {
        if (leaf.chainId === 42161 && hubPoolBalance.lt(this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf))) {
          this.clients.multiCallerClient.enqueueTransaction({
            contract: this.clients.hubPoolClient.hubPool,
            chainId: hubPoolChainId,
            method: "loadEthForL2Calls",
            args: [],
            message: "Loaded ETH for message to Arbitrum 📨!",
            mrkdwn,
            value: this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf),
          });
        }
        this.clients.multiCallerClient.enqueueTransaction({
          contract: this.clients.hubPoolClient.hubPool,
          chainId: hubPoolChainId,
          method: "executeRootBundle",
          args: [
            leaf.chainId,
            leaf.groupIndex,
            leaf.bundleLpFees,
            leaf.netSendAmounts,
            leaf.runningBalances,
            leaf.leafId,
            leaf.l1Tokens,
            proof,
          ],
          message: "Executed PoolRebalanceLeaf 🌿!",
          mrkdwn,
        });
      } else this.logger.debug({ at: "Dataworker#executePoolRebalanceLeaves", message: mrkdwn });
    });
  }

  async executeRelayerRefundLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients)),
    submitExecution = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ) {
    this.logger.debug({
      at: "Dataworker#executeRelayerRefundLeaves",
      message: "Executing relayer refund leaves",
    });

    let latestRootBundles = sortEventsDescending(this.clients.hubPoolClient.getValidatedRootBundles());
    if (this.spokeRootsLookbackCount !== 0) {
      latestRootBundles = latestRootBundles.slice(0, this.spokeRootsLookbackCount);
    }

    // Execute each chain's leaves sequentially to take advantage of pool rebalance root caching. If we executed
    // each chain in parallel, then we'd have to reconstruct identical pool rebalance root more times than necessary.
    for (const [_chainId, client] of Object.entries(spokePoolClients)) {
      const chainId = Number(_chainId);
      let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter((rootBundle) =>
        isKeyOf(chainId, IGNORED_SPOKE_BUNDLES)
          ? !IGNORED_SPOKE_BUNDLES[chainId].includes(rootBundle.rootBundleId)
          : rootBundle.blockNumber >= client.eventSearchConfig.fromBlock
      );

      // Filter out roots that are not in the latest N root bundles. This assumes that
      // relayerRefundRoot+slowFillRoot combinations are unique.
      rootBundleRelays = this._getRelayedRootsFromBundles(latestRootBundles, rootBundleRelays);

      // Filter out empty relayer refund root:
      rootBundleRelays = rootBundleRelays.filter((rootBundle) => rootBundle.relayerRefundRoot !== EMPTY_MERKLE_ROOT);

      this.logger.debug({
        at: "Dataworker#executeRelayerRefundLeaves",
        message: `Evaluating ${rootBundleRelays.length} historical non-empty relayer refund root bundles on chain ${chainId}`,
      });

      const executedLeavesForChain = client.getRelayerRefundExecutions();

      for (const rootBundleRelay of sortEventsAscending(rootBundleRelays)) {
        const matchingRootBundle = this.clients.hubPoolClient.getProposedRootBundles().find((bundle) => {
          if (bundle.relayerRefundRoot !== rootBundleRelay.relayerRefundRoot) return false;
          const followingBlockNumber =
            this.clients.hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber ||
            this.clients.hubPoolClient.latestBlockNumber;

          if (followingBlockNumber === undefined) return false;

          const leaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);

          // Only use this bundle if it had valid leaves returned (meaning it was at least partially executed).
          return leaves.length > 0;
        });

        if (!matchingRootBundle) {
          this.logger.warn({
            at: "Dataworke#executeRelayerRefundLeaves",
            message: "Couldn't find a matching mainnet root bundle for a relayerRefundRoot on L2!",
            chainId,
            relayerRefundRoot: rootBundleRelay.relayerRefundRoot,
            rootBundleId: rootBundleRelay.rootBundleId,
          });
          continue;
        }

        const prevRootBundle = this.clients.hubPoolClient.getLatestFullyExecutedRootBundle(
          matchingRootBundle.blockNumber
        );

        const blockNumberRanges = matchingRootBundle.bundleEvaluationBlockNumbers.map((endBlock, i) => {
          const fromBlock = prevRootBundle?.bundleEvaluationBlockNumbers?.[i]
            ? prevRootBundle.bundleEvaluationBlockNumbers[i].toNumber() + 1
            : 0;
          return [fromBlock, endBlock.toNumber()];
        });

        if (
          Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
          blockRangesAreInvalidForSpokeClients(
            spokePoolClients,
            blockNumberRanges,
            this.chainIdListForBundleEvaluationBlockNumbers,
            earliestBlocksInSpokePoolClients
          )
        ) {
          this.logger.warn({
            at: "Dataworke#executeRelayerRefundLeaves",
            message: "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
            chainId,
            rootBundleRanges: blockNumberRanges,
            earliestBlocksInSpokePoolClients,
            spokeClientsEventSearchConfigs: Object.fromEntries(
              Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
            ),
          });
          continue;
        }

        const { fillsToRefund, deposits, allValidFills, unfilledDeposits } =
          await this.clients.bundleDataClient.loadData(
            blockNumberRanges,
            spokePoolClients,
            false // Don't log this function's result since we're calling it once per chain per root bundle
          );

        const endBlockForMainnet = getBlockRangeForChain(
          blockNumberRanges,
          1,
          this.chainIdListForBundleEvaluationBlockNumbers
        )[1];
        const mainnetEndBlockTimestamp = (
          await this.clients.hubPoolClient.hubPool.provider.getBlock(endBlockForMainnet)
        ).timestamp;
        if (!this.clients.configStoreClient.hasValidConfigStoreVersionForTimestamp(mainnetEndBlockTimestamp)) {
          this.logger.debug({
            at: "Dataworke#executeRelayerRefundLeaves",
            message: "Cannot validate because missing updated ConfigStore version. Update to latest code.",
            mainnetEndBlockTimestamp,
            latestVersionSupported: CONFIG_STORE_VERSION,
            latestInConfigStore: this.clients.configStoreClient.getConfigStoreVersionForTimestamp(),
          });
          continue;
        }

        const allValidFillsInRange = getFillsInRange(
          allValidFills,
          blockNumberRanges,
          this.chainIdListForBundleEvaluationBlockNumbers
        );
        const expectedPoolRebalanceRoot = await this._getPoolRebalanceRoot(
          spokePoolClients,
          blockNumberRanges,
          matchingRootBundle.blockNumber,
          endBlockForMainnet,
          fillsToRefund,
          deposits,
          allValidFills,
          allValidFillsInRange,
          unfilledDeposits,
          false
        );

        const maxRefundCount = this.maxRefundCountOverride
          ? this.maxRefundCountOverride
          : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
        const { tree, leaves } = _buildRelayerRefundRoot(
          endBlockForMainnet,
          fillsToRefund,
          expectedPoolRebalanceRoot.leaves,
          expectedPoolRebalanceRoot.runningBalances,
          this.clients,
          maxRefundCount,
          this.tokenTransferThreshold
        );

        if (tree.getHexRoot() !== rootBundleRelay.relayerRefundRoot) {
          this.logger.warn({
            at: "Dataworke#executeRelayerRefundLeaves",
            message: "Constructed a different root for the block range!",
            chainId,
            rootBundleRelay,
            mainnetRootBundleBlock: matchingRootBundle.blockNumber,
            mainnetRootBundleTxn: matchingRootBundle.transactionHash,
            publishedRelayerRefundRoot: rootBundleRelay.relayerRefundRoot,
            constructedRelayerRefundRoot: tree.getHexRoot(),
          });
          continue;
        }

        const leavesForChain = leaves.filter((leaf) => leaf.chainId === Number(chainId));
        const unexecutedLeaves = leavesForChain.filter((leaf) => {
          const executedLeaf = executedLeavesForChain.find(
            (event) => event.rootBundleId === rootBundleRelay.rootBundleId && event.leafId === leaf.leafId
          );
          // Only return true if no leaf was found in the list of executed leaves.
          return !executedLeaf;
        });
        if (unexecutedLeaves.length === 0) continue;

        // Filter for leaves where the contract has the funding to send the required tokens.
        const fundedLeaves = (
          await Promise.all(
            unexecutedLeaves.map(async (leaf) => {
              const l1TokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(leaf.l2TokenAddress, chainId);
              const refundSum = leaf.refundAmounts.reduce((acc, curr) => acc.add(curr), BigNumber.from(0));
              const totalSent = refundSum.add(leaf.amountToReturn.gte(0) ? leaf.amountToReturn : BigNumber.from(0));
              const success = await balanceAllocator.requestBalanceAllocation(
                leaf.chainId,
                isOvmChain(leaf.chainId) && ovmWethTokens.includes(leaf.l2TokenAddress)
                  ? ovmWethTokens
                  : [leaf.l2TokenAddress],
                client.spokePool.address,
                totalSent
              );

              if (!success) {
                this.logger.warn({
                  at: "Dataworker#executeRelayerRefundLeaves",
                  message: "Not executing relayer refund leaf on SpokePool due to lack of funds.",
                  root: rootBundleRelay.relayerRefundRoot,
                  bundle: rootBundleRelay.rootBundleId,
                  leafId: leaf.leafId,
                  token: l1TokenInfo?.symbol,
                  chainId: leaf.chainId,
                  amountToReturn: leaf.amountToReturn,
                  refunds: leaf.refundAmounts,
                });
              }

              return success ? leaf : undefined;
            })
          )
        ).filter(isDefined);

        fundedLeaves.forEach((leaf) => {
          const l1TokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(leaf.l2TokenAddress, chainId);

          const mrkdwn = `rootBundleId: ${rootBundleRelay.rootBundleId}\nrelayerRefundRoot: ${
            rootBundleRelay.relayerRefundRoot
          }\nLeaf: ${leaf.leafId}\nchainId: ${chainId}\ntoken: ${
            l1TokenInfo?.symbol
          }\namount: ${leaf.amountToReturn.toString()}`;
          if (submitExecution)
            this.clients.multiCallerClient.enqueueTransaction({
              contract: client.spokePool,
              chainId: Number(chainId),
              method: "executeRelayerRefundLeaf",
              args: [rootBundleRelay.rootBundleId, leaf, tree.getHexProof(leaf)],
              message: "Executed RelayerRefundLeaf 🌿!",
              mrkdwn,
            });
          else this.logger.debug({ at: "Dataworker#executeRelayerRefundLeaves", message: mrkdwn });
        });
      }
    }
  }

  _proposeRootBundle(
    hubPoolChainId: number,
    bundleBlockRange: number[][],
    poolRebalanceLeaves: any[],
    poolRebalanceRoot: string,
    relayerRefundLeaves: any[],
    relayerRefundRoot: string,
    slowRelayLeaves: any[],
    slowRelayRoot: string
  ) {
    try {
      const bundleEndBlocks = bundleBlockRange.map((block) => block[1]);
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.hubPoolClient.hubPool, // target contract
        chainId: hubPoolChainId,
        method: "proposeRootBundle", // method called.
        args: [bundleEndBlocks, poolRebalanceLeaves.length, poolRebalanceRoot, relayerRefundRoot, slowRelayRoot], // props sent with function call.
        message: "Proposed new root bundle 🌱", // message sent to logger.
        mrkdwn: PoolRebalanceUtils.generateMarkdownForRootBundle(
          this.clients.hubPoolClient,
          this.chainIdListForBundleEvaluationBlockNumbers,
          hubPoolChainId,
          bundleBlockRange,
          [...poolRebalanceLeaves],
          poolRebalanceRoot,
          [...relayerRefundLeaves],
          relayerRefundRoot,
          [...slowRelayLeaves],
          slowRelayRoot
        ),
      });
    } catch (error) {
      this.logger.error({
        at: "Dataworker",
        message: "Error creating proposeRootBundleTx",
        error,
        notificationPath: "across-error",
      });
    }
  }

  _submitDisputeWithMrkdwn(hubPoolChainId: number, mrkdwn: string) {
    try {
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.hubPoolClient.hubPool, // target contract
        chainId: hubPoolChainId,
        method: "disputeRootBundle", // method called.
        args: [], // props sent with function call.
        message: "Disputed pending root bundle 👺", // message sent to logger.
        mrkdwn,
      });
    } catch (error) {
      this.logger.error({
        at: "Dataworker",
        message: "Error creating disputeRootBundleTx",
        error,
        notificationPath: "across-error",
      });
    }
  }

  async _getPoolRebalanceRoot(
    spokePoolClients: SpokePoolClientsByChain,
    blockRangesForChains: number[][],
    latestMainnetBlock: number,
    mainnetBundleEndBlock: number,
    fillsToRefund: FillsToRefund,
    deposits: DepositWithBlock[],
    allValidFills: FillWithBlock[],
    allValidFillsInRange: FillWithBlock[],
    unfilledDeposits: UnfilledDeposit[],
    logSlowFillExcessData = false
  ) {
    const key = JSON.stringify(blockRangesForChains);
    if (!this.rootCache[key]) {
      this.rootCache[key] = await _buildPoolRebalanceRoot(
        latestMainnetBlock,
        mainnetBundleEndBlock,
        fillsToRefund,
        deposits,
        allValidFills,
        allValidFillsInRange,
        unfilledDeposits,
        this.clients,
        spokePoolClients,
        this.chainIdListForBundleEvaluationBlockNumbers,
        this.maxL1TokenCountOverride,
        this.tokenTransferThreshold,
        logSlowFillExcessData ? this.logger : undefined
      );
    }

    return _.cloneDeep(this.rootCache[key]);
  }

  _getRequiredEthForArbitrumPoolRebalanceLeaf(leaf: PoolRebalanceLeaf) {
    // For arbitrum, the bot needs enough ETH to pay for each L1 -> L2 message.
    // The following executions trigger an L1 -> L2 message:
    // 1. The first arbitrum leaf for a particular set of roots. This means the roots must be sent and is
    //    signified by groupIndex === 0.
    // 2. Any netSendAmount > 0 triggers an L1 -> L2 token send, which costs 0.02 ETH.
    let requiredAmount = leaf.netSendAmounts.reduce(
      (acc, curr) => (curr.gt(0) ? acc.add(toBNWei("0.02")) : acc),
      BigNumber.from(0)
    );

    if (leaf.groupIndex === 0) requiredAmount = requiredAmount.add(toBNWei("0.02"));
    return requiredAmount;
  }

  /**
   * Filters out any root bundles that don't have a matching relayerRefundRoot+slowRelayRoot combination in the
   * list of proposed root bundles `allRootBundleRelays`.
   * @param targetRootBundles Root bundles whose relayed roots we want to find
   * @param allRootBundleRelays All relayed roots to search
   * @returns Relayed roots that originated from rootBundles contained in allRootBundleRelays
   */
  _getRelayedRootsFromBundles(
    targetRootBundles: ProposedRootBundle[],
    allRootBundleRelays: RootBundleRelayWithBlock[]
  ): RootBundleRelayWithBlock[] {
    return allRootBundleRelays.filter((rootBundle) =>
      targetRootBundles.some(
        (_rootBundle) =>
          _rootBundle.relayerRefundRoot === rootBundle.relayerRefundRoot &&
          _rootBundle.slowRelayRoot === rootBundle.slowRelayRoot
      )
    );
  }
}
