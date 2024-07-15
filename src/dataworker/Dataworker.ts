import assert from "assert";
import { Contract, utils as ethersUtils } from "ethers";
import { utils as sdkUtils } from "@across-protocol/sdk";
import {
  bnZero,
  winston,
  EMPTY_MERKLE_ROOT,
  sortEventsDescending,
  BigNumber,
  getNetworkName,
  MerkleTree,
  sortEventsAscending,
  isDefined,
  toBNWei,
  ZERO_ADDRESS,
  chainIsMatic,
  CHAIN_IDs,
} from "../utils";
import {
  DepositWithBlock,
  InvalidFill,
  ProposedRootBundle,
  RootBundleRelayWithBlock,
  SpokePoolClientsByChain,
  PendingRootBundle,
  RunningBalances,
  PoolRebalanceLeaf,
  RelayerRefundLeaf,
  V3SlowFillLeaf,
  FillStatus,
} from "../interfaces";
import { DataworkerClients } from "./DataworkerClientHelper";
import { SpokePoolClient, BalanceAllocator } from "../clients";
import * as PoolRebalanceUtils from "./PoolRebalanceUtils";
import {
  blockRangesAreInvalidForSpokeClients,
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
  l2TokensToCountTowardsSpokePoolLeafExecutionCapital,
} from "../dataworker/DataworkerUtils";
import {
  getEndBlockBuffers,
  _buildPoolRebalanceRoot,
  _buildRelayerRefundRoot,
  _buildSlowRelayRoot,
} from "./DataworkerUtils";
import _ from "lodash";
import { CONTRACT_ADDRESSES, spokePoolClientsToProviders } from "../common";
import * as sdk from "@across-protocol/sdk";
import {
  BundleDepositsV3,
  BundleExcessSlowFills,
  BundleFillsV3,
  BundleSlowFills,
  ExpiredDepositsToRefundV3,
} from "../interfaces/BundleData";

// Internal error reasons for labeling a pending root bundle as "invalid" that we don't want to submit a dispute
// for. These errors are due to issues with the dataworker configuration, instead of with the pending root
// bundle. Any reasons in IGNORE_X we emit a "debug" level log for, and any reasons in ERROR_X we emit an "error"
// level log for.
const IGNORE_DISPUTE_REASONS = new Set(["bundle-end-block-buffer"]);
const ERROR_DISPUTE_REASONS = new Set(["insufficient-dataworker-lookback", "out-of-date-config-store-version"]);

// Create a type for storing a collection of roots
type SlowRootBundle = {
  leaves: V3SlowFillLeaf[];
  tree: MerkleTree<V3SlowFillLeaf>;
};

export type BundleDataToPersistToDALayerType = {
  bundleBlockRanges: number[][];
  bundleDepositsV3: BundleDepositsV3;
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3;
  bundleFillsV3: BundleFillsV3;
  unexecutableSlowFills: BundleExcessSlowFills;
  bundleSlowFillsV3: BundleSlowFills;
};

type ProposeRootBundleReturnType = {
  poolRebalanceLeaves: PoolRebalanceLeaf[];
  poolRebalanceTree: MerkleTree<PoolRebalanceLeaf>;
  relayerRefundLeaves: RelayerRefundLeaf[];
  relayerRefundTree: MerkleTree<RelayerRefundLeaf>;
  slowFillLeaves: V3SlowFillLeaf[];
  slowFillTree: MerkleTree<V3SlowFillLeaf>;
  dataToPersistToDALayer: BundleDataToPersistToDALayerType;
};

export type PoolRebalanceRoot = {
  runningBalances: RunningBalances;
  realizedLpFees: RunningBalances;
  leaves: PoolRebalanceLeaf[];
  tree: MerkleTree<PoolRebalanceLeaf>;
};

type PoolRebalanceRootCache = Record<string, Promise<PoolRebalanceRoot>>;

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  rootCache: PoolRebalanceRootCache = {};

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: DataworkerClients,
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly maxRefundCountOverride: number | undefined,
    readonly maxL1TokenCountOverride: number | undefined,
    readonly blockRangeEndBlockBuffer: { [chainId: number]: number } = {},
    readonly spokeRootsLookbackCount = 0,
    readonly bufferToPropose = 0,
    readonly forceProposal = false,
    readonly forceBundleRange?: [number, number][]
  ) {
    if (
      maxRefundCountOverride !== undefined ||
      maxL1TokenCountOverride !== undefined ||
      Object.keys(blockRangeEndBlockBuffer).length > 0
    ) {
      this.logger.debug({
        at: "Dataworker#Constructor",
        message: "Dataworker constructed with overridden config store settings",
        chainIdListForBundleEvaluationBlockNumbers,
        maxRefundCountOverride: this.maxRefundCountOverride,
        maxL1TokenCountOverride: this.maxL1TokenCountOverride,
        blockRangeEndBlockBuffer: this.blockRangeEndBlockBuffer,
      });
    }
  }

  isV3(_blockNumber: number): boolean {
    _blockNumber; // lint
    return true;
  }

  // This should be called whenever it's possible that the loadData information for a block range could have changed.
  // For instance, if the spoke or hub clients have been updated, it probably makes sense to clear this to be safe.
  clearCache(): void {
    this.clients.bundleDataClient.clearCache();
    this.rootCache = {};
  }

  async buildSlowRelayRoot(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient }
  ): Promise<SlowRootBundle> {
    const { bundleSlowFillsV3 } = await this.clients.bundleDataClient.loadData(blockRangesForChains, spokePoolClients);
    return _buildSlowRelayRoot(bundleSlowFillsV3);
  }

  async buildRelayerRefundRoot(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    poolRebalanceLeaves: PoolRebalanceLeaf[],
    runningBalances: RunningBalances
  ): Promise<{
    leaves: RelayerRefundLeaf[];
    tree: MerkleTree<RelayerRefundLeaf>;
  }> {
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForChains,
      this.clients.hubPoolClient.chainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    const { bundleFillsV3, expiredDepositsToRefundV3 } = await this.clients.bundleDataClient.loadData(
      blockRangesForChains,
      spokePoolClients
    );
    const maxRefundCount = this.maxRefundCountOverride
      ? this.maxRefundCountOverride
      : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
    return _buildRelayerRefundRoot(
      endBlockForMainnet,
      bundleFillsV3,
      expiredDepositsToRefundV3,
      poolRebalanceLeaves,
      runningBalances,
      this.clients,
      maxRefundCount
    );
  }

  // This method is only used in testing and scripts, not to propose new bundles.
  async buildPoolRebalanceRoot(
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain,
    latestMainnetBlock?: number
  ): Promise<PoolRebalanceRoot> {
    const { bundleDepositsV3, bundleFillsV3, bundleSlowFillsV3, unexecutableSlowFills, expiredDepositsToRefundV3 } =
      await this.clients.bundleDataClient.loadData(blockRangesForChains, spokePoolClients);

    const mainnetBundleEndBlock = getBlockRangeForChain(
      blockRangesForChains,
      this.clients.hubPoolClient.chainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    return await this._getPoolRebalanceRoot(
      blockRangesForChains,
      latestMainnetBlock ?? mainnetBundleEndBlock,
      mainnetBundleEndBlock,
      bundleDepositsV3,
      bundleFillsV3,
      bundleSlowFillsV3,
      unexecutableSlowFills,
      expiredDepositsToRefundV3
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
    const mostRecentProposedRootBundle = this.clients.hubPoolClient.getLatestFullyExecutedRootBundle(
      this.clients.hubPoolClient.latestBlockSearched
    );

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
    if (expectedPoolRebalanceLeaves === 0) {
      throw new Error("Pool rebalance leaf count must be > 0");
    }
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

  /**
   * Returns the next bundle block ranges if a new proposal is possible, otherwise
   * returns undefined.
   * @param spokePoolClients
   * @param earliestBlocksInSpokePoolClients Earliest blocks loaded in SpokePoolClients. Used to determine severity
   * of log level
   * @returns Array of blocks ranges to propose for next bundle.
   */
  async _getNextProposalBlockRanges(
    spokePoolClients: SpokePoolClientsByChain,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<number[][] | undefined> {
    const { configStoreClient, hubPoolClient } = this.clients;

    // Check if a bundle is pending.
    if (!hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient not updated");
    }
    if (!this.forceProposal && hubPoolClient.hasPendingProposal()) {
      this.logger.debug({ at: "Dataworker#propose", message: "Has pending proposal, cannot propose" });
      return;
    }

    // If config store version isn't up to date, return early. This is a simple rule that is perhaps too aggressive
    // but the proposer role is a specialized one and the user should always be using updated software.
    if (!configStoreClient.hasLatestConfigStoreVersion) {
      this.logger.warn({
        at: "Dataworker#propose",
        message: "Skipping proposal because missing updated ConfigStore version, are you using the latest code?",
        latestVersionSupported: configStoreClient.configStoreVersion,
        latestInConfigStore: configStoreClient.getConfigStoreVersionForTimestamp(),
      });
      return;
    }

    // Construct a list of ending block ranges for each chain that we want to include
    // relay events for. The ending block numbers for these ranges will be added to a "bundleEvaluationBlockNumbers"
    // list, and the order of chain ID's is hardcoded in the ConfigStore client.
    const nextBundleMainnetStartBlock = this.getNextHubChainBundleStartBlock();
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(nextBundleMainnetStartBlock);
    const blockRangesForProposal = this._getWidestPossibleBlockRangeForNextBundle(
      spokePoolClients,
      nextBundleMainnetStartBlock
    );
    const mainnetBlockRange = getBlockRangeForChain(blockRangesForProposal, hubPoolClient.chainId, chainIds);

    // Exit early if spoke pool clients don't have early enough event data to satisfy block ranges for the
    // potential proposal
    if (
      Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
      (await blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        blockRangesForProposal,
        chainIds,
        earliestBlocksInSpokePoolClients,
        this.isV3(mainnetBlockRange[0])
      ))
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

    // Narrow the block range depending on potential data incoherencies.
    const safeBlockRanges = await this.narrowProposalBlockRanges(blockRangesForProposal, spokePoolClients);
    return safeBlockRanges;
  }

  getNextHubChainBundleStartBlock(chainIdList = this.chainIdListForBundleEvaluationBlockNumbers): number {
    const hubPoolClient = this.clients.hubPoolClient;
    return hubPoolClient.getNextBundleStartBlockNumber(
      chainIdList,
      hubPoolClient.latestBlockSearched,
      hubPoolClient.chainId
    );
  }

  async proposeRootBundle(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    usdThresholdToSubmitNewBundle?: BigNumber,
    submitProposals = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<BundleDataToPersistToDALayerType> {
    // TODO: Handle the case where we can't get event data or even blockchain data from any chain. This will require
    // some changes to override the bundle block range here, and loadData to skip chains with zero block ranges.
    // For now, we assume that if one blockchain fails to return data, then this entire function will fail. This is a
    // safe strategy but could lead to new roots failing to be proposed until ALL networks are healthy.

    // If we are forcing a bundle range, then we should use that instead of the next proposal block ranges.
    const blockRangesForProposal = isDefined(this.forceBundleRange)
      ? this.forceBundleRange
      : await this._getNextProposalBlockRanges(spokePoolClients, earliestBlocksInSpokePoolClients);

    if (!blockRangesForProposal) {
      return;
    }

    const { chainId: hubPoolChainId, latestBlockSearched } = this.clients.hubPoolClient;
    const mainnetBundleEndBlock = blockRangesForProposal[0][1];

    this.logger.debug({
      at: "Dataworker#propose",
      message: "Proposing root bundle",
      blockRangesForProposal,
    });
    const logData = true;
    const rootBundleData = await this._proposeRootBundle(
      blockRangesForProposal,
      spokePoolClients,
      latestBlockSearched,
      false, // Don't load data from arweave when proposing.
      logData
    );

    if (usdThresholdToSubmitNewBundle !== undefined) {
      // Exit early if volume of pool rebalance leaves exceeds USD threshold. Volume includes netSendAmounts only since
      // that is the actual amount sent over bridges. This also mitigates the chance that a RelayerRefundLeaf is
      // published but its refund currency isn't sent over the bridge in a PoolRebalanceLeaf.
      const totalUsdRefund = await PoolRebalanceUtils.computePoolRebalanceUsdVolume(
        rootBundleData.poolRebalanceLeaves,
        this.clients
      );
      if (totalUsdRefund.lt(usdThresholdToSubmitNewBundle)) {
        this.logger.debug({
          at: "Dataworker",
          message: "Root bundle USD volume does not exceed threshold, exiting early 🟡",
          usdThresholdToSubmitNewBundle,
          totalUsdRefund,
          leaves: rootBundleData.poolRebalanceLeaves,
        });
        return;
      } else {
        this.logger.debug({
          at: "Dataworker",
          message: "Root bundle USD volume exceeds threshold! 💚",
          usdThresholdToSubmitNewBundle,
          totalUsdRefund,
        });
      }
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
    } else {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "Proceeding to propose new bundle",
        shouldWaitToPropose,
      });
    }

    if (rootBundleData.poolRebalanceLeaves.length === 0) {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "No pool rebalance leaves, cannot propose",
      });
      return;
    }

    // 4. Propose roots to HubPool contract.
    this.logger.debug({
      at: "Dataworker#propose",
      message: "Enqueing new root bundle proposal txn",
      blockRangesForProposal,
      poolRebalanceLeavesCount: rootBundleData.poolRebalanceLeaves.length,
      poolRebalanceRoot: rootBundleData.poolRebalanceTree.getHexRoot(),
      relayerRefundRoot: rootBundleData.relayerRefundTree.getHexRoot(),
      slowRelayRoot: rootBundleData.slowFillTree.getHexRoot(),
    });
    if (submitProposals) {
      this.enqueueRootBundleProposal(
        hubPoolChainId,
        blockRangesForProposal,
        rootBundleData.poolRebalanceLeaves,
        rootBundleData.poolRebalanceTree.getHexRoot(),
        rootBundleData.relayerRefundLeaves,
        rootBundleData.relayerRefundTree.getHexRoot(),
        rootBundleData.slowFillLeaves,
        rootBundleData.slowFillTree.getHexRoot()
      );
    }
    return rootBundleData.dataToPersistToDALayer;
  }

  async narrowProposalBlockRanges(
    blockRanges: number[][],
    spokePoolClients: SpokePoolClientsByChain
  ): Promise<number[][]> {
    const chainIds = this.chainIdListForBundleEvaluationBlockNumbers;
    const updatedBlockRanges = Object.fromEntries(chainIds.map((chainId, idx) => [chainId, [...blockRanges[idx]]]));

    const { bundleInvalidFillsV3: invalidFills } = await this.clients.bundleDataClient.loadData(
      blockRanges,
      spokePoolClients
    );

    // Helper to update a chain's end block correctly, accounting for soft-pausing if needed.
    const updateEndBlock = (chainId: number, endBlock?: number): void => {
      const [currentStartBlock, currentEndBlock] = updatedBlockRanges[chainId];
      const previousEndBlock = this.clients.hubPoolClient.getLatestBundleEndBlockForChain(
        chainIds,
        this.clients.hubPoolClient.latestBlockSearched,
        chainId
      );

      endBlock ??= previousEndBlock;
      assert(
        endBlock < currentEndBlock,
        `Invalid block range update for chain ${chainId}: block ${endBlock} >= ${currentEndBlock}`
      );

      // If endBlock is equal to or before the currentEndBlock then the chain is "soft-paused" by setting the bundle
      // start and end block equal to the previous end block. This tells the dataworker to not progress on that chain.
      updatedBlockRanges[chainId] =
        endBlock > currentStartBlock ? [currentStartBlock, endBlock] : [previousEndBlock, previousEndBlock];
    };

    // If invalid fills were detected and they appear to be due to gaps in FundsDeposited events:
    // - Narrow the origin block range to exclude the missing deposit, AND
    // - Narrow the destination block range to exclude the invalid fill.
    invalidFills
      .filter(({ code }) => code === InvalidFill.DepositIdNotFound)
      .forEach(({ fill: { depositId, originChainId, destinationChainId, blockNumber } }) => {
        const [originChain, destinationChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];

        // Exclude the missing deposit on the origin chain.
        const originSpokePoolClient = spokePoolClients[originChainId];
        let [startBlock, endBlock] = updatedBlockRanges[originChainId];

        // Find the previous known deposit. This may resolve a deposit before the immediately preceding depositId.
        const previousDeposit = originSpokePoolClient
          .getDepositsForDestinationChain(destinationChainId)
          .filter((deposit: DepositWithBlock) => deposit.blockNumber < blockNumber)
          .at(-1);

        updateEndBlock(originChainId, previousDeposit?.blockNumber);
        this.logger.debug({
          at: "Dataworker::narrowBlockRanges",
          message: `Narrowed proposal block range on ${originChain} due to missing deposit.`,
          depositId,
          previousBlockRange: [startBlock, endBlock],
          newBlockRange: updatedBlockRanges[originChainId],
        });

        // Update the endBlock on the destination chain to exclude the invalid fill.
        const destSpokePoolClient = spokePoolClients[destinationChainId];
        [startBlock, endBlock] = updatedBlockRanges[destinationChainId];

        // The blockNumber is iteratively narrowed in this loop so this fill might already be excluded.
        if (blockNumber <= endBlock) {
          // Find the fill immediately preceding this invalid fill.
          const previousFill = destSpokePoolClient
            .getFillsWithBlockInRange(startBlock, Math.max(blockNumber - 1, startBlock))
            .at(-1);

          // Wind back to the bundle end block number to that of the previous fill.
          updateEndBlock(destinationChainId, previousFill?.blockNumber);
          this.logger.debug({
            at: "Dataworker::narrowBlockRanges",
            message: `Narrowed proposal block range on ${destinationChain} due to missing deposit on ${originChain}.`,
            depositId,
            previousBlockRange: [startBlock, endBlock],
            newBlockRange: updatedBlockRanges[destinationChainId],
          });
        }
      });

    // Quick sanity check - make sure that the block ranges are coherent. A chain may be soft-paused if it has ongoing
    // RPC issues (block ranges are frozen at the previous proposal endBlock), so ensure that this is also handled.
    const finalBlockRanges = chainIds.map((chainId) => updatedBlockRanges[chainId]);
    const coherentBlockRanges = finalBlockRanges.every(([startBlock, endBlock], idx) => {
      const [originalStartBlock] = blockRanges[idx];
      return (
        (endBlock > startBlock && startBlock === originalStartBlock) ||
        (startBlock === endBlock && startBlock === originalStartBlock - 1) // soft-pause
      );
    });
    assert(coherentBlockRanges, "Updated proposal block ranges are incoherent");

    return finalBlockRanges;
  }

  async _proposeRootBundle(
    blockRangesForProposal: number[][],
    spokePoolClients: SpokePoolClientsByChain,
    latestMainnetBundleEndBlock: number,
    loadDataFromArweave = false,
    logData = false
  ): Promise<ProposeRootBundleReturnType> {
    const timerStart = Date.now();

    const { bundleDepositsV3, bundleFillsV3, bundleSlowFillsV3, unexecutableSlowFills, expiredDepositsToRefundV3 } =
      await this.clients.bundleDataClient.loadData(blockRangesForProposal, spokePoolClients, loadDataFromArweave);

    // Prepare information about what we need to store to Arweave for the bundle.
    // We will be doing this at a later point so that we can confirm that this data is worth storing.
    const dataToPersistToDALayer = {
      bundleBlockRanges: blockRangesForProposal,
      bundleDepositsV3,
      expiredDepositsToRefundV3,
      bundleFillsV3,
      unexecutableSlowFills,
      bundleSlowFillsV3,
    };
    const [, mainnetBundleEndBlock] = blockRangesForProposal[0];

    const poolRebalanceRoot = await this._getPoolRebalanceRoot(
      blockRangesForProposal,
      latestMainnetBundleEndBlock,
      mainnetBundleEndBlock,
      bundleDepositsV3,
      bundleFillsV3,
      bundleSlowFillsV3,
      unexecutableSlowFills,
      expiredDepositsToRefundV3
    );
    const relayerRefundRoot = _buildRelayerRefundRoot(
      mainnetBundleEndBlock,
      bundleFillsV3,
      expiredDepositsToRefundV3,
      poolRebalanceRoot.leaves,
      poolRebalanceRoot.runningBalances,
      this.clients,
      this.maxRefundCountOverride
        ? this.maxRefundCountOverride
        : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(mainnetBundleEndBlock)
    );
    const slowRelayRoot = _buildSlowRelayRoot(bundleSlowFillsV3);

    if (logData) {
      this.logger.debug({
        at: "Dataworker",
        message: `Time to build root bundles for block ranges ${JSON.stringify(blockRangesForProposal)} : ${
          Date.now() - timerStart
        }ms`,
      });
      PoolRebalanceUtils.prettyPrintLeaves(
        this.logger,
        poolRebalanceRoot.tree,
        poolRebalanceRoot.leaves,
        "Pool rebalance"
      );
      PoolRebalanceUtils.prettyPrintLeaves(
        this.logger,
        relayerRefundRoot.tree,
        relayerRefundRoot.leaves,
        "Relayer refund"
      );
      PoolRebalanceUtils.prettyPrintLeaves(this.logger, slowRelayRoot.tree, slowRelayRoot.leaves, "Slow relay");
    }

    return {
      poolRebalanceLeaves: poolRebalanceRoot.leaves,
      poolRebalanceTree: poolRebalanceRoot.tree,
      relayerRefundLeaves: relayerRefundRoot.leaves,
      relayerRefundTree: relayerRefundRoot.tree,
      slowFillLeaves: slowRelayRoot.leaves,
      slowFillTree: slowRelayRoot.tree,
      dataToPersistToDALayer,
    };
  }

  async validatePendingRootBundle(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    submitDisputes = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<void> {
    if (!this.clients.hubPoolClient.isUpdated || this.clients.hubPoolClient.currentTime === undefined) {
      throw new Error("HubPoolClient not updated");
    }
    const hubPoolChainId = this.clients.hubPoolClient.chainId;

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

    const nextBundleMainnetStartBlock = this.getNextHubChainBundleStartBlock();
    const widestPossibleExpectedBlockRange = this._getWidestPossibleBlockRangeForNextBundle(
      spokePoolClients,
      // Mainnet bundle start block for pending bundle is the first entry in the first entry.
      nextBundleMainnetStartBlock
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
        if (submitDisputes) {
          this._submitDisputeWithMrkdwn(hubPoolChainId, reason);
        }
      }
    }
  }

  async validateRootBundle(
    hubPoolChainId: number,
    widestPossibleExpectedBlockRange: number[][],
    rootBundle: PendingRootBundle,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    earliestBlocksInSpokePoolClients: { [chainId: number]: number },
    loadDataFromArweave = false
  ): Promise<
    // If valid is false, we get a reason and we might get expected trees.
    | {
        valid: false;
        reason: string;
        expectedTrees?: {
          poolRebalanceTree: {
            tree: MerkleTree<PoolRebalanceLeaf>;
            leaves: PoolRebalanceLeaf[];
          };
          relayerRefundTree: {
            tree: MerkleTree<RelayerRefundLeaf>;
            leaves: RelayerRefundLeaf[];
          };
          slowRelayTree: {
            tree: MerkleTree<V3SlowFillLeaf>;
            leaves: V3SlowFillLeaf[];
          };
        };
      }
    // If valid is true, we don't get a reason, and we always get expected trees.
    | {
        valid: true;
        reason: undefined;
        expectedTrees: {
          poolRebalanceTree: {
            tree: MerkleTree<PoolRebalanceLeaf>;
            leaves: PoolRebalanceLeaf[];
          };
          relayerRefundTree: {
            tree: MerkleTree<RelayerRefundLeaf>;
            leaves: RelayerRefundLeaf[];
          };
          slowRelayTree: {
            tree: MerkleTree<V3SlowFillLeaf>;
            leaves: V3SlowFillLeaf[];
          };
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

    const blockRangesImpliedByBundleEndBlocks = widestPossibleExpectedBlockRange.map((blockRange, index) => [
      blockRange[0],
      rootBundle.bundleEvaluationBlockNumbers[index],
    ]);
    const mainnetBlockRange = blockRangesImpliedByBundleEndBlocks[0];
    const mainnetBundleStartBlock = mainnetBlockRange[0];
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(mainnetBundleStartBlock);
    const endBlockBuffers = getEndBlockBuffers(chainIds, this.blockRangeEndBlockBuffer);

    // Make sure that all end blocks are >= expected start blocks. Allow for situation where chain was halted
    // and bundle end blocks hadn't advanced at time of proposal, meaning that the end blocks were equal to the
    // previous end blocks. So, even if by the time the disputer runs, the chain has started advancing again, then
    // the proposed block is at most 1 behind the next expected block range.
    if (
      rootBundle.bundleEvaluationBlockNumbers.some(
        (block, index) => block + 1 < widestPossibleExpectedBlockRange[index][0]
      )
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
          chainIds,
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
            chainIds,
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

    // Exit early if spoke pool clients don't have early enough event data to satisfy block ranges for the
    // pending proposal. Log an error loudly so that user knows that disputer needs to increase its lookback.
    if (
      Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
      (await blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        blockRangesImpliedByBundleEndBlocks,
        chainIds,
        earliestBlocksInSpokePoolClients,
        this.isV3(mainnetBlockRange[0])
      ))
    ) {
      this.logger.debug({
        at: "Dataworke#validate",
        message: "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
        rootBundleRanges: blockRangesImpliedByBundleEndBlocks,
        availableSpokePoolClients: Object.keys(spokePoolClients),
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
      chainIdListForBundleEvaluationBlockNumbers: chainIds,
    });

    // If config store version isn't up to date, return early. This is a simple rule that is perhaps too aggressive
    // but the proposer role is a specialized one and the user should always be using updated software.
    if (!this.clients.configStoreClient.hasLatestConfigStoreVersion) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Cannot validate because missing updated ConfigStore version. Update to latest code.",
        latestVersionSupported: this.clients.configStoreClient.configStoreVersion,
        latestInConfigStore: this.clients.configStoreClient.getConfigStoreVersionForTimestamp(),
      });
      return {
        valid: false,
        reason: "out-of-date-config-store-version",
      };
    }

    // Check if we have the right code to validate a bundle for the given block ranges.
    const versionAtProposalBlock =
      this.clients.configStoreClient.getConfigStoreVersionForBlock(mainnetBundleStartBlock);

    // Bundles that need to be validated with older code should emit helpful error logs about which code to run.
    // @dev only throw this error if the hub chain ID is 1, suggesting we're running on production.
    if (
      versionAtProposalBlock <= sdk.constants.TRANSFER_THRESHOLD_MAX_CONFIG_STORE_VERSION &&
      hubPoolChainId === CHAIN_IDs.MAINNET
    ) {
      throw new Error(
        "Must use relayer code at commit 412ddc30af72c2ac78f9e4c8dccfccfd0eb478ab to validate a bundle with transferThreshold set"
      );
    }

    const logData = true;
    const rootBundleData = await this._proposeRootBundle(
      blockRangesImpliedByBundleEndBlocks,
      spokePoolClients,
      rootBundle.proposalBlockNumber,
      loadDataFromArweave,
      logData
    );

    const expectedPoolRebalanceRoot = {
      leaves: rootBundleData.poolRebalanceLeaves,
      tree: rootBundleData.poolRebalanceTree,
    };
    const expectedRelayerRefundRoot = {
      leaves: rootBundleData.relayerRefundLeaves,
      tree: rootBundleData.relayerRefundTree,
    };
    const expectedSlowRelayRoot = {
      leaves: rootBundleData.slowFillLeaves,
      tree: rootBundleData.slowFillTree,
    };
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
          chainIds,
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
  ): Promise<void> {
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
        let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter(
          (rootBundle) => rootBundle.blockNumber >= client.eventSearchConfig.fromBlock
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

        const slowFillsForChain = client.getFills().filter(sdkUtils.isSlowFill);
        for (const rootBundleRelay of sortEventsAscending(rootBundleRelays)) {
          const matchingRootBundle = this.clients.hubPoolClient.getProposedRootBundles().find((bundle) => {
            if (bundle.slowRelayRoot !== rootBundleRelay.slowRelayRoot) {
              return false;
            }

            const followingBlockNumber =
              this.clients.hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber ||
              this.clients.hubPoolClient.latestBlockSearched;

            if (!followingBlockNumber) {
              return false;
            }

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

          const blockNumberRanges = getImpliedBundleBlockRanges(
            this.clients.hubPoolClient,
            this.clients.configStoreClient,
            matchingRootBundle
          );
          const mainnetBlockRange = blockNumberRanges[0];
          const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(mainnetBlockRange[0]);
          if (
            Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
            (await blockRangesAreInvalidForSpokeClients(
              spokePoolClients,
              blockNumberRanges,
              chainIds,
              earliestBlocksInSpokePoolClients,
              this.isV3(mainnetBlockRange[0])
            ))
          ) {
            this.logger.warn({
              at: "Dataworke#executeSlowRelayLeaves",
              message:
                "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
              chainId,
              rootBundleRanges: blockNumberRanges,
              availableSpokePoolClients: Object.keys(spokePoolClients),
              earliestBlocksInSpokePoolClients,
              spokeClientsEventSearchConfigs: Object.fromEntries(
                Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
              ),
            });
            continue;
          }

          const rootBundleData = await this._proposeRootBundle(
            blockNumberRanges,
            spokePoolClients,
            matchingRootBundle.blockNumber,
            true // Load data from arweave when executing for speed.
          );

          const { slowFillLeaves: leaves, slowFillTree: tree } = rootBundleData;
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

          // Filter out slow fill leaves for other chains and also expired deposits.
          const currentTime = client.getCurrentTime();
          const leavesForChain = leaves.filter(
            (leaf) => leaf.chainId === chainId && leaf.relayData.fillDeadline >= currentTime
          );
          const unexecutedLeaves = leavesForChain.filter((leaf) => {
            const executedLeaf = slowFillsForChain.find(
              (event) =>
                event.originChainId === leaf.relayData.originChainId && event.depositId === leaf.relayData.depositId
            );

            // Only return true if no leaf was found in the list of executed leaves.
            return !executedLeaf;
          });
          if (unexecutedLeaves.length === 0) {
            continue;
          }

          await this._executeSlowFillLeaf(
            unexecutedLeaves,
            balanceAllocator,
            client,
            tree,
            submitExecution,
            rootBundleRelay.rootBundleId
          );
        }
      })
    );
  }

  async _executeSlowFillLeaf(
    _leaves: V3SlowFillLeaf[],
    balanceAllocator: BalanceAllocator,
    client: SpokePoolClient,
    slowRelayTree: MerkleTree<V3SlowFillLeaf>,
    submitExecution: boolean,
    rootBundleId?: number
  ): Promise<void> {
    // Ignore slow fill leaves for deposits with messages as these messages might be very expensive to execute.
    // The original depositor can always execute these and pay for the gas themselves.
    const leaves = _leaves.filter((leaf) => {
      const {
        relayData: { depositor, recipient, message },
      } = leaf;

      // If there is a message, we ignore the leaf and log an error.
      if (!sdk.utils.isMessageEmpty(message)) {
        const { method, args } = this.encodeV3SlowFillLeaf(slowRelayTree, rootBundleId, leaf);

        this.logger.warn({
          at: "Dataworker#_executeSlowFillLeaf",
          message: "Ignoring slow fill leaf with message",
          method,
          args,
        });
        return false;
      }

      const ignoredAddresses = JSON.parse(process.env.IGNORED_ADDRESSES ?? "[]").map((address) =>
        ethersUtils.getAddress(address)
      );
      if (
        ignoredAddresses?.includes(ethersUtils.getAddress(depositor)) ||
        ignoredAddresses?.includes(ethersUtils.getAddress(recipient))
      ) {
        this.logger.warn({
          at: "Dataworker#_executeSlowFillLeaf",
          message: "Ignoring slow fill.",
          leafExecutionArgs: [depositor, recipient],
        });
        return false;
      }

      return true;
    });

    if (leaves.length === 0) {
      return;
    }

    const chainId = client.chainId;

    const sortedFills = client.getFills();
    const latestFills = leaves.map((slowFill) => {
      const { relayData, chainId: slowFillChainId } = slowFill;

      // Start with the most recent fills and search backwards.
      const fill = _.findLast(sortedFills, (fill) => {
        if (
          !(
            fill.depositId === relayData.depositId &&
            fill.originChainId === relayData.originChainId &&
            sdkUtils.getRelayDataHash(fill, chainId) === sdkUtils.getRelayDataHash(relayData, slowFillChainId)
          )
        ) {
          return false;
        }
        return true;
      });

      return fill;
    });

    // Filter for leaves where the contract has the funding to send the required tokens.
    const fundedLeaves = (
      await Promise.all(
        leaves.map(async (slowFill, idx) => {
          const destinationChainId = slowFill.chainId;
          if (destinationChainId !== chainId) {
            throw new Error(`Leaf chainId does not match input chainId (${destinationChainId} != ${chainId})`);
          }

          // @dev check if there's been a duplicate leaf execution and if so, then exit early.
          // Since this function is happening near the end of the dataworker run and leaf executions are
          // relatively infrequent, the additional RPC latency and cost is acceptable.
          const fillStatus = await sdkUtils.relayFillStatus(
            client.spokePool,
            slowFill.relayData,
            "latest",
            destinationChainId
          );
          if (fillStatus === FillStatus.Filled) {
            this.logger.debug({
              at: "Dataworker#executeSlowRelayLeaves",
              message: `Slow Fill Leaf for output token ${slowFill.relayData.outputToken} on chain ${destinationChainId} already executed`,
            });
            return undefined;
          }

          const { outputAmount } = slowFill.relayData;
          const fill = latestFills[idx];
          const amountRequired = isDefined(fill) ? bnZero : slowFill.updatedOutputAmount;

          // If the fill has been completed there's no need to execute the slow fill leaf.
          if (amountRequired.eq(bnZero)) {
            return undefined;
          }

          const { outputToken } = slowFill.relayData;
          const success = await balanceAllocator.requestBalanceAllocation(
            destinationChainId,
            l2TokensToCountTowardsSpokePoolLeafExecutionCapital(outputToken, destinationChainId),
            client.spokePool.address,
            amountRequired
          );

          if (!success) {
            this.logger.warn({
              at: "Dataworker#executeSlowRelayLeaves",
              message: "Not executing slow relay leaf due to lack of funds in SpokePool",
              root: slowRelayTree.getHexRoot(),
              bundle: rootBundleId,
              depositId: slowFill.relayData.depositId,
              fromChain: slowFill.relayData.originChainId,
              chainId: destinationChainId,
              token: outputToken,
              amount: outputAmount,
            });
          }

          // Assume we don't need to add balance in the BalanceAllocator to the HubPool because the slow fill's
          // recipient wouldn't be the HubPool in normal circumstances.
          return success ? slowFill : undefined;
        })
      )
    ).filter(isDefined);

    const hubChainId = this.clients.hubPoolClient.chainId;
    fundedLeaves.forEach((leaf) => {
      assert(leaf.chainId === chainId);

      const { relayData } = leaf;
      const { outputAmount } = relayData;
      const mrkdwn =
        `rootBundleId: ${rootBundleId}\n` +
        `slowRelayRoot: ${slowRelayTree.getHexRoot()}\n` +
        `Origin chain: ${relayData.originChainId}\n` +
        `Destination chain:${chainId}\n` +
        `Deposit Id: ${relayData.depositId}\n` +
        `amount: ${outputAmount.toString()}`;

      if (submitExecution) {
        const { method, args } = this.encodeV3SlowFillLeaf(slowRelayTree, rootBundleId, leaf);

        this.clients.multiCallerClient.enqueueTransaction({
          contract: client.spokePool,
          chainId,
          method,
          args,
          message: "Executed SlowRelayLeaf 🌿!",
          mrkdwn,
          // If mainnet, send through Multicall3 so it can be batched with PoolRebalanceLeaf executions, otherwise
          // SpokePool.multicall() is fine.
          unpermissioned: chainId === hubChainId,
          // If simulating mainnet execution, can fail as it may require funds to be sent from
          // pool rebalance leaf.
          canFailInSimulation: chainId === hubChainId,
          // If polygon, keep separate from relayer refund leaves since we can't execute refunds atomically
          // with fills.
          groupId: chainIsMatic(chainId) ? "slowRelay" : undefined,
        });
      } else {
        this.logger.debug({ at: "Dataworker#executeSlowRelayLeaves", message: mrkdwn });
      }
    });
  }

  encodeV3SlowFillLeaf(
    slowRelayTree: MerkleTree<V3SlowFillLeaf>,
    rootBundleId: number,
    leaf: V3SlowFillLeaf
  ): { method: string; args: (number | string[] | V3SlowFillLeaf)[] } {
    const { relayData, chainId, updatedOutputAmount } = leaf;

    const method = "executeV3SlowRelayLeaf";
    const proof = slowRelayTree.getHexProof({ relayData, chainId, updatedOutputAmount });
    const args = [leaf, rootBundleId, proof];

    return { method, args };
  }

  /**
   * @notice Executes outstanding pool rebalance leaves if they have passed the challenge window. Includes
   * exchange rate updates needed to execute leaves.
   * @param spokePoolClients
   * @param balanceAllocator
   * @param submitExecution
   * @param earliestBlocksInSpokePoolClients
   * @returns number of leaves executed
   */
  async executePoolRebalanceLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients)),
    submitExecution = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<number> {
    let leafCount = 0;
    this.logger.debug({
      at: "Dataworker#executePoolRebalanceLeaves",
      message: "Executing pool rebalance leaves",
    });

    if (!this.clients.hubPoolClient.isUpdated || this.clients.hubPoolClient.currentTime === undefined) {
      throw new Error("HubPoolClient not updated");
    }
    const hubPoolChainId = this.clients.hubPoolClient.chainId;

    // Exit early if a bundle is not pending.
    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundle();
    if (pendingRootBundle === undefined) {
      this.logger.debug({
        at: "Dataworker#executePoolRebalanceLeaves",
        message: "No pending proposal, nothing to execute",
      });
      return leafCount;
    }

    this.logger.debug({
      at: "Dataworker#executePoolRebalanceLeaves",
      message: "Found pending proposal",
      pendingRootBundle,
    });

    const nextBundleMainnetStartBlock = this.getNextHubChainBundleStartBlock();
    const widestPossibleExpectedBlockRange = this._getWidestPossibleBlockRangeForNextBundle(
      spokePoolClients,
      nextBundleMainnetStartBlock
    );
    const { valid, reason, expectedTrees } = await this.validateRootBundle(
      hubPoolChainId,
      widestPossibleExpectedBlockRange,
      pendingRootBundle,
      spokePoolClients,
      earliestBlocksInSpokePoolClients,
      true // Load data from arweave when executing leaves for speed.
    );

    if (!valid) {
      // In the case where the Dataworker config is improperly configured, emit an error level alert so bot runner
      // can get dataworker running ASAP.
      if (IGNORE_DISPUTE_REASONS.has(reason)) {
        this.logger.debug({
          at: "Dataworker#executePoolRebalanceLeaves",
          message: "Dataworker configuration error, should resolve itself eventually 😪",
          reason,
        });
      } else {
        this.logger.error({
          at: "Dataworker#executePoolRebalanceLeaves",
          message: ERROR_DISPUTE_REASONS.has(reason)
            ? "Dataworker configuration error needs to be fixed"
            : "Found invalid proposal after challenge period!",
          reason,
        });
      }
      return leafCount;
    }

    if (valid && !expectedTrees) {
      this.logger.error({
        at: "Dataworker#executePoolRebalanceLeaves",
        message:
          "Found valid proposal, but no trees could be generated. This probably means that the proposal was never evaluated during liveness due to an odd block range!",
        reason,
        notificationPath: "across-error",
      });
      return leafCount;
    }

    // Exit early if challenge period timestamp has not passed:
    if (this.clients.hubPoolClient.currentTime <= pendingRootBundle.challengePeriodEndTimestamp) {
      this.logger.debug({
        at: "Dataworker#executePoolRebalanceLeaves",
        message: `Challenge period not passed, cannot execute until ${pendingRootBundle.challengePeriodEndTimestamp}`,
        expirationTime: pendingRootBundle.challengePeriodEndTimestamp,
      });
      return leafCount;
    }

    // At this point, check again that there are still unexecuted pool rebalance leaves. This is done because the above
    // logic, to reconstruct this pool rebalance root and the prerequisite spoke pool client updates, can take a while.
    const pendingProposal: PendingRootBundle = await this.clients.hubPoolClient.hubPool.rootBundleProposal();
    if (pendingProposal.unclaimedPoolRebalanceLeafCount === 0) {
      this.logger.debug({
        at: "Dataworker#executePoolRebalanceLeaves",
        message: "Exiting early due to dataworker function collision",
      });
      return leafCount;
    }

    const executedLeaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(
      this.clients.hubPoolClient.getLatestProposedRootBundle(),
      this.clients.hubPoolClient.latestBlockSearched
    );

    // Filter out previously executed leaves.
    const unexecutedLeaves = expectedTrees.poolRebalanceTree.leaves.filter((leaf) =>
      executedLeaves.every(({ leafId }) => leafId !== leaf.leafId)
    );
    if (unexecutedLeaves.length === 0) {
      return leafCount;
    }

    // There are three times that we should look to update the HubPool's liquid reserves:
    // 1. First, before we attempt to execute the HubChain PoolRebalance leaves and RelayerRefund leaves.
    //    We should see if there are new liquid reserves we need to account for before sending out these
    //    netSendAmounts.
    // 2. Second, before we attempt to execute the PoolRebalance leaves for the other chains. We should
    //    see if there are new liquid reserves we need to account for before sending out these netSendAmounts. This
    //    updated liquid reserves balance could be from previous finalizations or any amountToReturn value sent
    //    back from the Ethereum RelayerRefundLeaves.
    // 3. Third, we haven't updated the exchange rate for an L1 token on a PoolRebalanceLeaf in a while that
    //    we're going to execute, so we should batch in an update.
    let updatedLiquidReserves: Record<string, BigNumber> = {};

    // First, execute mainnet pool rebalance leaves. Then try to execute any relayer refund and slow leaves for the
    // expected relayed root hash, then proceed with remaining pool rebalance leaves. This is an optimization that
    // takes advantage of the fact that mainnet transfers between HubPool and SpokePool are atomic.
    const mainnetLeaves = unexecutedLeaves.filter((leaf) => leaf.chainId === hubPoolChainId);
    if (mainnetLeaves.length > 0) {
      assert(mainnetLeaves.length === 1);
      updatedLiquidReserves = await this._updateExchangeRatesBeforeExecutingHubChainLeaves(
        mainnetLeaves[0],
        submitExecution
      );
      leafCount += await this._executePoolRebalanceLeaves(
        spokePoolClients,
        mainnetLeaves,
        balanceAllocator,
        expectedTrees.poolRebalanceTree.tree,
        submitExecution
      );

      // We need to know the next root bundle ID for the mainnet spoke pool in order to execute leaves for roots that
      // will be relayed after executing the above pool rebalance root.
      const nextRootBundleIdForMainnet = spokePoolClients[hubPoolChainId].getLatestRootBundleId();

      // Now, execute refund and slow fill leaves for Mainnet using new funds. These methods will return early if there
      // are no relevant leaves to execute.
      await this._executeSlowFillLeaf(
        expectedTrees.slowRelayTree.leaves.filter((leaf) => leaf.chainId === hubPoolChainId),
        balanceAllocator,
        spokePoolClients[hubPoolChainId],
        expectedTrees.slowRelayTree.tree,
        submitExecution,
        nextRootBundleIdForMainnet
      );
      await this._executeRelayerRefundLeaves(
        expectedTrees.relayerRefundTree.leaves.filter((leaf) => leaf.chainId === hubPoolChainId),
        balanceAllocator,
        spokePoolClients[hubPoolChainId],
        expectedTrees.relayerRefundTree.tree,
        submitExecution,
        nextRootBundleIdForMainnet
      );
    }

    // Before executing the other pool rebalance leaves, see if we should update any exchange rates to account for
    // any tokens returned to the hub pool via the EthereumSpokePool that we'll need to use to execute
    // any of the remaining pool rebalance leaves. This might include tokens we've already enqueued to update
    // in the previous step, but this captures any tokens that are sent back from the Ethereum_SpokePool to the
    // HubPool that we want to capture an increased liquidReserves for.
    const nonHubChainPoolRebalanceLeaves = unexecutedLeaves.filter((leaf) => leaf.chainId !== hubPoolChainId);
    if (nonHubChainPoolRebalanceLeaves.length === 0) {
      return leafCount;
    }
    const updatedL1Tokens = await this._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
      updatedLiquidReserves,
      balanceAllocator,
      nonHubChainPoolRebalanceLeaves,
      submitExecution
    );
    Object.keys(updatedLiquidReserves).forEach((token) => {
      if (!updatedL1Tokens.has(token)) {
        updatedL1Tokens.add(token);
      }
    });

    // Save all L1 tokens that we haven't updated exchange rates for in a different step.
    const l1TokensWithPotentiallyOlderUpdate = expectedTrees.poolRebalanceTree.leaves.reduce((l1TokenSet, leaf) => {
      const currLeafL1Tokens = leaf.l1Tokens;
      currLeafL1Tokens.forEach((l1Token) => {
        if (!l1TokenSet.includes(l1Token) && !updatedL1Tokens.has(l1Token)) {
          l1TokenSet.push(l1Token);
        }
      });
      return l1TokenSet;
    }, []);
    await this._updateOldExchangeRates(l1TokensWithPotentiallyOlderUpdate, submitExecution);

    // Perform similar funding checks for remaining non-mainnet pool rebalance leaves.
    leafCount += await this._executePoolRebalanceLeaves(
      spokePoolClients,
      nonHubChainPoolRebalanceLeaves,
      balanceAllocator,
      expectedTrees.poolRebalanceTree.tree,
      submitExecution
    );
    return leafCount;
  }

  async _executePoolRebalanceLeaves(
    spokePoolClients: {
      [chainId: number]: SpokePoolClient;
    },
    leaves: PoolRebalanceLeaf[],
    balanceAllocator: BalanceAllocator,
    tree: MerkleTree<PoolRebalanceLeaf>,
    submitExecution: boolean
  ): Promise<number> {
    const hubPoolChainId = this.clients.hubPoolClient.chainId;
    const fundedLeaves = (
      await Promise.all(
        leaves.map(async (leaf) => {
          const requests = leaf.netSendAmounts.map((amount, i) => ({
            amount: amount.gt(bnZero) ? amount : bnZero,
            tokens: [leaf.l1Tokens[i]],
            holder: this.clients.hubPoolClient.hubPool.address,
            chainId: hubPoolChainId,
          }));

          if (sdkUtils.chainIsArbitrum(leaf.chainId)) {
            const hubPoolBalance = await this.clients.hubPoolClient.hubPool.provider.getBalance(
              this.clients.hubPoolClient.hubPool.address
            );
            if (hubPoolBalance.lt(this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf))) {
              requests.push({
                tokens: [ZERO_ADDRESS],
                amount: this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf),
                holder: await this.clients.hubPoolClient.hubPool.signer.getAddress(),
                chainId: hubPoolChainId,
              });
            }
          }

          const success = await balanceAllocator.requestBalanceAllocations(
            requests.filter((req) => req.amount.gt(bnZero))
          );

          if (!success) {
            // Note: this is an error because the HubPool should generally not run out of funds to put into
            // netSendAmounts. This means that no new bundles can be proposed until this leaf is funded.
            this.logger.error({
              at: "Dataworker#executePoolRebalanceLeaves",
              message: "Not executing pool rebalance leaf on HubPool due to lack of funds to send.",
              root: tree.getHexRoot(),
              leafId: leaf.leafId,
              rebalanceChain: leaf.chainId,
              token: leaf.l1Tokens,
              netSendAmounts: leaf.netSendAmounts,
            });
          } else {
            // Add balances to spoke pool on mainnet since we know it will be sent atomically.
            if (leaf.chainId === hubPoolChainId) {
              await Promise.all(
                leaf.netSendAmounts.map(async (amount, i) => {
                  if (amount.gt(bnZero)) {
                    await balanceAllocator.addUsed(
                      leaf.chainId,
                      leaf.l1Tokens[i],
                      spokePoolClients[leaf.chainId].spokePool.address,
                      amount.mul(-1)
                    );
                  }
                })
              );
            }
          }
          return success ? leaf : undefined;
        })
      )
    ).filter(isDefined);

    let hubPoolBalance;
    if (fundedLeaves.some((leaf) => sdkUtils.chainIsArbitrum(leaf.chainId))) {
      hubPoolBalance = await this.clients.hubPoolClient.hubPool.provider.getBalance(
        this.clients.hubPoolClient.hubPool.address
      );
    }
    fundedLeaves.forEach((leaf) => {
      const proof = tree.getHexProof(leaf);
      const mrkdwn = `Root hash: ${tree.getHexRoot()}\nLeaf: ${leaf.leafId}\nChain: ${leaf.chainId}`;
      if (submitExecution) {
        if (sdkUtils.chainIsArbitrum(leaf.chainId)) {
          if (hubPoolBalance.lt(this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf))) {
            this.clients.multiCallerClient.enqueueTransaction({
              contract: this.clients.hubPoolClient.hubPool,
              chainId: hubPoolChainId,
              method: "loadEthForL2Calls",
              args: [],
              message: `Loaded ETH for message to ${getNetworkName(leaf.chainId)} 📨!`,
              mrkdwn,
              value: this._getRequiredEthForArbitrumPoolRebalanceLeaf(leaf),
            });
          }
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
          unpermissioned: true,
          // If simulating execution of leaves for non-mainnet chains, can fail as it may require funds to be returned
          // from relayer refund leaves.
          canFailInSimulation: leaf.chainId !== hubPoolChainId,
        });
      } else {
        this.logger.debug({ at: "Dataworker#executePoolRebalanceLeaves", message: mrkdwn });
      }
    });
    return fundedLeaves.length;
  }

  async _updateExchangeRatesBeforeExecutingHubChainLeaves(
    poolRebalanceLeaf: Pick<PoolRebalanceLeaf, "netSendAmounts" | "l1Tokens">,
    submitExecution: boolean
  ): Promise<Record<string, BigNumber>> {
    const hubPool = this.clients.hubPoolClient.hubPool;
    const chainId = this.clients.hubPoolClient.chainId;

    const updatedL1Tokens: Record<string, BigNumber> = {};
    const { netSendAmounts, l1Tokens } = poolRebalanceLeaf;
    await sdk.utils.forEachAsync(l1Tokens, async (l1Token, idx) => {
      const tokenSymbol = this.clients.hubPoolClient.getTokenInfo(chainId, l1Token)?.symbol;

      // If netSendAmounts is negative, there is no need to update this exchange rate.
      if (netSendAmounts[idx].lte(0)) {
        return;
      }

      const multicallInput = [
        hubPool.interface.encodeFunctionData("pooledTokens", [l1Token]),
        hubPool.interface.encodeFunctionData("sync", [l1Token]),
        hubPool.interface.encodeFunctionData("pooledTokens", [l1Token]),
      ];
      const multicallOutput = await hubPool.callStatic.multicall(multicallInput);
      const currentPooledTokens = hubPool.interface.decodeFunctionResult("pooledTokens", multicallOutput[0]);
      const updatedPooledTokens = hubPool.interface.decodeFunctionResult("pooledTokens", multicallOutput[2]);
      const currentLiquidReserves = currentPooledTokens.liquidReserves;
      const updatedLiquidReserves = updatedPooledTokens.liquidReserves;

      // If current liquid reserves can cover the netSendAmount, then there is no need to update the exchange rate.
      if (currentLiquidReserves.gte(netSendAmounts[idx])) {
        this.logger.debug({
          at: "Dataworker#_updateExchangeRatesBeforeExecutingHubChainLeaves",
          message: `Skipping exchange rate update for ${tokenSymbol} because current liquid reserves > netSendAmount for hubChain`,
          currentLiquidReserves,
          netSendAmount: netSendAmounts[idx],
          l1Token,
        });
        return;
      }

      // If updated liquid reserves are not enough to cover the payment, then send a warning that
      // we're short on funds.
      if (updatedLiquidReserves.lt(netSendAmounts[idx])) {
        this.logger.error({
          at: "Dataworker#_updateExchangeRatesBeforeExecutingHubChainLeaves",
          message: `Not enough funds to execute pool rebalance leaf on HubPool for token: ${tokenSymbol}`,
          poolRebalanceLeaf,
          netSendAmount: netSendAmounts[idx],
          currentPooledTokens,
          updatedPooledTokens,
        });
        return;
      }

      this.logger.debug({
        at: "Dataworker#_updateExchangeRatesBeforeExecutingHubChainLeaves",
        message: `Updating exchange rate update for ${tokenSymbol} because we need to update the liquid reserves of the contract to execute the hubChain poolRebalanceLeaf.`,
        poolRebalanceLeaf,
        netSendAmount: netSendAmounts[idx],
        currentPooledTokens,
        updatedPooledTokens,
      });
      updatedL1Tokens[l1Token] = updatedPooledTokens.liquidReserves;
      if (submitExecution) {
        this.clients.multiCallerClient.enqueueTransaction({
          contract: hubPool,
          chainId,
          method: "exchangeRateCurrent",
          args: [l1Token],
          message: "Updated exchange rate ♻️!",
          mrkdwn: `Updated exchange rate for l1 token: ${tokenSymbol}`,
          unpermissioned: true,
        });
      }
    });
    return updatedL1Tokens;
  }

  async _updateExchangeRatesBeforeExecutingNonHubChainLeaves(
    latestLiquidReserves: Record<string, BigNumber>,
    balanceAllocator: BalanceAllocator,
    poolRebalanceLeaves: Pick<PoolRebalanceLeaf, "netSendAmounts" | "l1Tokens" | "chainId">[],
    submitExecution: boolean
  ): Promise<Set<string>> {
    const updatedL1Tokens = new Set<string>();
    const hubPool = this.clients.hubPoolClient.hubPool;
    const hubPoolChainId = this.clients.hubPoolClient.chainId;

    await sdkUtils.forEachAsync(poolRebalanceLeaves, async (leaf) => {
      await sdkUtils.forEachAsync(leaf.l1Tokens, async (l1Token, idx) => {
        const tokenSymbol = this.clients.hubPoolClient.getTokenInfo(hubPoolChainId, l1Token)?.symbol;

        if (updatedL1Tokens.has(l1Token)) {
          return;
        }
        // If leaf's netSendAmount is negative, then we don't need to updateExchangeRates since the Hub will not
        // have a liquidity constraint because it won't be sending any tokens.
        if (leaf.netSendAmounts[idx].lte(0)) {
          return;
        }
        // The "used" balance kept in the BalanceAllocator should have adjusted for the netSendAmounts and relayer refund leaf
        // executions above. Therefore, check if the current liquidReserves is less than the pool rebalance leaf's netSendAmount
        // and the virtual hubPoolBalance would be enough to execute it. If so, then add an update exchange rate call to make sure that
        // the HubPool becomes "aware" of its inflow following the relayre refund leaf execution.
        let currHubPoolLiquidReserves = latestLiquidReserves[l1Token];
        if (!currHubPoolLiquidReserves) {
          // @dev If there aren't liquid reserves for this token then set them to max value so we won't update them.
          currHubPoolLiquidReserves = this.clients.hubPoolClient.getLpTokenInfoForL1Token(l1Token).liquidReserves;
        }
        assert(currHubPoolLiquidReserves !== undefined);
        // We only need to update the exchange rate in the case where tokens are returned to the HubPool increasing
        // its balance enough that it can execute a pool rebalance leaf it otherwise would not be able to.
        // This would only happen if the starting hub pool balance is below the net send amount. If it started
        // above, then the dataworker would not purposefully send tokens out of it to fulfill the Ethereum
        // PoolRebalanceLeaf and then return tokens to it to execute another chain's PoolRebalanceLeaf.
        if (currHubPoolLiquidReserves.gte(leaf.netSendAmounts[idx])) {
          this.logger.debug({
            at: "Dataworker#_updateExchangeRatesBeforeExecutingNonHubChainLeaves",
            message: `Skipping exchange rate update for ${tokenSymbol} because current liquid reserves > netSendAmount for chain ${leaf.chainId}`,
            l2ChainId: leaf.chainId,
            currHubPoolLiquidReserves,
            netSendAmount: leaf.netSendAmounts[idx],
            l1Token,
          });
          return;
        }

        // @dev: Virtual balance = post-sync liquid reserves + any used balance.
        const multicallInput = [
          hubPool.interface.encodeFunctionData("sync", [l1Token]),
          hubPool.interface.encodeFunctionData("pooledTokens", [l1Token]),
        ];
        const multicallOutput = await hubPool.callStatic.multicall(multicallInput);
        const updatedPooledTokens = hubPool.interface.decodeFunctionResult("pooledTokens", multicallOutput[1]);
        const updatedLiquidReserves = updatedPooledTokens.liquidReserves;
        const virtualHubPoolBalance = updatedLiquidReserves.sub(
          balanceAllocator.getUsed(hubPoolChainId, l1Token, hubPool.address)
        );

        // If the virtual balance is still too low to execute the pool leaf, then log an error that this will
        // pool rebalance leaf execution will fail.
        if (virtualHubPoolBalance.lt(leaf.netSendAmounts[idx])) {
          this.logger.error({
            at: "Dataworker#executePoolRebalanceLeaves",
            message: "Executing pool rebalance leaf on HubPool will fail due to lack of funds to send.",
            leaf: leaf,
            l1Token,
            netSendAmount: leaf.netSendAmounts[idx],
            updatedLiquidReserves,
            virtualHubPoolBalance,
          });
          return;
        }
        this.logger.debug({
          at: "Dataworker#executePoolRebalanceLeaves",
          message: `Relayer refund leaf will return enough funds to HubPool to execute PoolRebalanceLeaf, updating exchange rate for ${tokenSymbol}`,
          updatedLiquidReserves,
          virtualHubPoolBalance,
          netSendAmount: leaf.netSendAmounts[idx],
          leaf,
        });
        updatedL1Tokens.add(l1Token);
      });
    });

    // Submit executions at the end since the above double loop runs in parallel and we don't want to submit
    // multiple transactions for the same token.
    if (submitExecution) {
      for (const l1Token of updatedL1Tokens) {
        const tokenSymbol = this.clients.hubPoolClient.getTokenInfo(hubPoolChainId, l1Token)?.symbol;
        this.clients.multiCallerClient.enqueueTransaction({
          contract: this.clients.hubPoolClient.hubPool,
          chainId: hubPoolChainId,
          method: "exchangeRateCurrent",
          args: [l1Token],
          message: "Updated exchange rate ♻️!",
          mrkdwn: `Updated exchange rate for l1 token: ${tokenSymbol}`,
          unpermissioned: true,
        });
      }
    }

    return updatedL1Tokens;
  }

  async _updateOldExchangeRates(l1Tokens: string[], submitExecution: boolean): Promise<void> {
    const hubPool = this.clients.hubPoolClient.hubPool;
    const chainId = this.clients.hubPoolClient.chainId;
    const seenL1Tokens = new Set<string>();

    await sdk.utils.forEachAsync(l1Tokens, async (l1Token) => {
      if (seenL1Tokens.has(l1Token)) {
        return;
      }
      seenL1Tokens.add(l1Token);
      const tokenSymbol = this.clients.hubPoolClient.getTokenInfo(chainId, l1Token)?.symbol;

      // Exit early if we recently synced this token.
      const latestFeesCompoundedTime =
        this.clients.hubPoolClient.getLpTokenInfoForL1Token(l1Token)?.lastLpFeeUpdate ?? 0;
      // Force update every 2 days:
      if (
        this.clients.hubPoolClient.currentTime === undefined ||
        this.clients.hubPoolClient.currentTime - latestFeesCompoundedTime <= 2 * 24 * 60 * 60
      ) {
        const timeToNextUpdate = 2 * 24 * 60 * 60 - (this.clients.hubPoolClient.currentTime - latestFeesCompoundedTime);
        this.logger.debug({
          at: "Dataworker#_updateOldExchangeRates",
          message: `Skipping exchange rate update for ${tokenSymbol} because it was recently updated. Seconds to next update: ${timeToNextUpdate}s`,
          lastUpdateTime: latestFeesCompoundedTime,
        });
        return;
      }

      const multicallInput = [
        hubPool.interface.encodeFunctionData("pooledTokens", [l1Token]),
        hubPool.interface.encodeFunctionData("sync", [l1Token]),
        hubPool.interface.encodeFunctionData("pooledTokens", [l1Token]),
      ];
      const multicallOutput = await hubPool.callStatic.multicall(multicallInput);
      const currentPooledTokens = hubPool.interface.decodeFunctionResult("pooledTokens", multicallOutput[0]);
      const updatedPooledTokens = hubPool.interface.decodeFunctionResult("pooledTokens", multicallOutput[2]);
      const currentLiquidReserves = currentPooledTokens.liquidReserves;
      const updatedLiquidReserves = updatedPooledTokens.liquidReserves;
      if (currentLiquidReserves.gte(updatedLiquidReserves)) {
        this.logger.debug({
          at: "Dataworker#_updateOldExchangeRates",
          message: `Skipping exchange rate update for ${tokenSymbol} because liquid reserves would not increase`,
          currentLiquidReserves,
          updatedLiquidReserves,
        });
        return;
      }

      this.logger.debug({
        at: "Dataworker#_updateOldExchangeRates",
        message: `Updating exchange rate for ${tokenSymbol}`,
        lastUpdateTime: latestFeesCompoundedTime,
        currentLiquidReserves,
        updatedLiquidReserves,
        l1Token,
      });
      if (submitExecution) {
        this.clients.multiCallerClient.enqueueTransaction({
          contract: hubPool,
          chainId,
          method: "exchangeRateCurrent",
          args: [l1Token],
          message: "Updated exchange rate ♻️!",
          mrkdwn: `Updated exchange rate for l1 token: ${tokenSymbol}`,
          unpermissioned: true,
        });
      }
    });
  }

  async executeRelayerRefundLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients)),
    submitExecution = true,
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<void> {
    const { configStoreClient, hubPoolClient } = this.clients;
    this.logger.debug({ at: "Dataworker#executeRelayerRefundLeaves", message: "Executing relayer refund leaves" });

    let latestRootBundles = sortEventsDescending(hubPoolClient.getValidatedRootBundles());
    if (this.spokeRootsLookbackCount !== 0) {
      latestRootBundles = latestRootBundles.slice(0, this.spokeRootsLookbackCount);
    }

    // Execute each chain's leaves sequentially to take advantage of pool rebalance root caching. If we executed
    // each chain in parallel, then we'd have to reconstruct identical pool rebalance root more times than necessary.
    for (const [_chainId, client] of Object.entries(spokePoolClients)) {
      const chainId = Number(_chainId);
      let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter(
        (rootBundle) => rootBundle.blockNumber >= client.eventSearchConfig.fromBlock
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
        const matchingRootBundle = hubPoolClient.getProposedRootBundles().find((bundle) => {
          if (bundle.relayerRefundRoot !== rootBundleRelay.relayerRefundRoot) {
            return false;
          }
          const followingBlockNumber =
            hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber || hubPoolClient.latestBlockSearched;

          if (followingBlockNumber === undefined) {
            return false;
          }

          const leaves = hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);

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

        const blockNumberRanges = getImpliedBundleBlockRanges(hubPoolClient, configStoreClient, matchingRootBundle);
        const mainnetBlockRanges = blockNumberRanges[0];
        const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(mainnetBlockRanges[0]);
        if (
          Object.keys(earliestBlocksInSpokePoolClients).length > 0 &&
          (await blockRangesAreInvalidForSpokeClients(
            spokePoolClients,
            blockNumberRanges,
            chainIds,
            earliestBlocksInSpokePoolClients,
            this.isV3(mainnetBlockRanges[0])
          ))
        ) {
          this.logger.warn({
            at: "Dataworke#executeRelayerRefundLeaves",
            message: "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
            chainId,
            rootBundleRanges: blockNumberRanges,
            availableSpokePoolClients: Object.keys(spokePoolClients),
            earliestBlocksInSpokePoolClients,
            spokeClientsEventSearchConfigs: Object.fromEntries(
              Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.eventSearchConfig])
            ),
          });
          continue;
        }

        const { relayerRefundLeaves: leaves, relayerRefundTree: tree } = await this._proposeRootBundle(
          blockNumberRanges,
          spokePoolClients,
          matchingRootBundle.blockNumber,
          true // load data from Arweave for speed purposes
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
        if (unexecutedLeaves.length === 0) {
          continue;
        }

        await this._executeRelayerRefundLeaves(
          unexecutedLeaves,
          balanceAllocator,
          client,
          tree,
          submitExecution,
          rootBundleRelay.rootBundleId
        );
      }
    }
  }

  async _executeRelayerRefundLeaves(
    leaves: RelayerRefundLeaf[],
    balanceAllocator: BalanceAllocator,
    client: SpokePoolClient,
    relayerRefundTree: MerkleTree<RelayerRefundLeaf>,
    submitExecution: boolean,
    rootBundleId: number
  ): Promise<void> {
    if (leaves.length === 0) {
      return;
    }
    const chainId = client.chainId;

    // If the chain is Linea, then we need to allocate ETH in the call to executeRelayerRefundLeaf. This is currently
    // unique to the L2 -> L1 relay direction for Linea. We will make this variable generic defaulting to undefined
    // for other chains.
    const LINEA_FEE_TO_SEND_MSG_TO_L1 = sdkUtils.chainIsLinea(chainId)
      ? await this._getRequiredEthForLineaRelayLeafExecution(client)
      : undefined;
    const getMsgValue = (leaf: RelayerRefundLeaf): BigNumber | undefined => {
      // Only need to include a msg.value if amountToReturn > 0 and we need to send tokens back to HubPool.
      if (LINEA_FEE_TO_SEND_MSG_TO_L1 && leaf.amountToReturn.gt(0)) {
        return LINEA_FEE_TO_SEND_MSG_TO_L1;
      }
      return undefined;
    };

    // Filter for leaves where the contract has the funding to send the required tokens.
    const fundedLeaves = (
      await Promise.all(
        leaves.map(async (leaf) => {
          if (leaf.chainId !== chainId) {
            throw new Error("Leaf chainId does not match input chainId");
          }
          const l1TokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(leaf.l2TokenAddress, chainId);
          // @dev check if there's been a duplicate leaf execution and if so, then exit early.
          // Since this function is happening near the end of the dataworker run and leaf executions are
          // relatively infrequent, the additional RPC latency and cost is acceptable.
          // @dev Can only filter on indexed events.
          const eventFilter = client.spokePool.filters.ExecutedRelayerRefundRoot(
            null, // amountToReturn
            leaf.chainId,
            null, // refundAmounts
            rootBundleId,
            leaf.leafId
          );
          const duplicateEvents = await client.spokePool.queryFilter(
            eventFilter,
            client.latestBlockSearched - (client.eventSearchConfig.maxBlockLookBack ?? 5_000)
          );
          if (duplicateEvents.length > 0) {
            this.logger.debug({
              at: "Dataworker#executeRelayerRefundLeaves",
              message: `Relayer Refund Leaf #${leaf.leafId} for ${l1TokenInfo?.symbol} on chain ${leaf.chainId} already executed`,
              duplicateEvents,
            });
            return undefined;
          }
          const refundSum = leaf.refundAmounts.reduce((acc, curr) => acc.add(curr), BigNumber.from(0));
          const totalSent = refundSum.add(leaf.amountToReturn.gte(0) ? leaf.amountToReturn : BigNumber.from(0));
          const balanceRequestsToQuery = [
            {
              chainId: leaf.chainId,
              tokens: l2TokensToCountTowardsSpokePoolLeafExecutionCapital(leaf.l2TokenAddress, leaf.chainId),
              holder: client.spokePool.address,
              amount: totalSent,
            },
          ];

          const valueToPassViaPayable = getMsgValue(leaf);
          // If we have to pass ETH via the payable function, then we need to add a balance request for the signer
          // to ensure that it has enough ETH to send.
          // NOTE: this is ETH required separately from the amount required to send the tokens
          if (isDefined(valueToPassViaPayable)) {
            balanceRequestsToQuery.push({
              chainId: leaf.chainId,
              tokens: [ZERO_ADDRESS], // ZERO_ADDRESS is used to represent ETH.
              holder: await client.spokePool.signer.getAddress(), // The signer's address is what will be sending the ETH.
              amount: valueToPassViaPayable,
            });
          }
          // We use the requestBalanceAllocations instead of two separate calls to requestBalanceAllocation because
          // we want the balance to be set in an atomic transaction.
          const success = await balanceAllocator.requestBalanceAllocations(balanceRequestsToQuery);
          if (!success) {
            this.logger.warn({
              at: "Dataworker#executeRelayerRefundLeaves",
              message: "Not executing relayer refund leaf on SpokePool due to lack of funds.",
              root: relayerRefundTree.getHexRoot(),
              bundle: rootBundleId,
              leafId: leaf.leafId,
              token: l1TokenInfo?.symbol,
              chainId: leaf.chainId,
              amountToReturn: leaf.amountToReturn,
              refunds: leaf.refundAmounts,
            });
          } else {
            // If mainnet leaf, then allocate balance to the HubPool since it will be atomically transferred.
            if (leaf.chainId === this.clients.hubPoolClient.chainId && leaf.amountToReturn.gt(0)) {
              balanceAllocator.addUsed(
                leaf.chainId,
                leaf.l2TokenAddress,
                this.clients.hubPoolClient.hubPool.address,
                leaf.amountToReturn.mul(-1)
              );
            }
          }

          return success ? leaf : undefined;
        })
      )
    ).filter(isDefined);

    fundedLeaves.forEach((leaf) => {
      const l1TokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(leaf.l2TokenAddress, chainId);

      const mrkdwn = `rootBundleId: ${rootBundleId}\nrelayerRefundRoot: ${relayerRefundTree.getHexRoot()}\nLeaf: ${
        leaf.leafId
      }\nchainId: ${chainId}\ntoken: ${l1TokenInfo?.symbol}\namount: ${leaf.amountToReturn.toString()}`;
      if (submitExecution) {
        const valueToPassViaPayable = getMsgValue(leaf);
        this.clients.multiCallerClient.enqueueTransaction({
          value: valueToPassViaPayable,
          contract: client.spokePool,
          chainId: Number(chainId),
          method: "executeRelayerRefundLeaf",
          args: [rootBundleId, leaf, relayerRefundTree.getHexProof(leaf)],
          message: "Executed RelayerRefundLeaf 🌿!",
          mrkdwn,
          // If mainnet, send through Multicall3 so it can be batched with PoolRebalanceLeaf executions, otherwise
          // SpokePool.multicall() is fine.
          unpermissioned: Number(chainId) === CHAIN_IDs.MAINNET,
          // If simulating mainnet execution, can fail as it may require funds to be sent from
          // pool rebalance leaf.
          canFailInSimulation: leaf.chainId === this.clients.hubPoolClient.chainId,
        });
      } else {
        this.logger.debug({ at: "Dataworker#executeRelayerRefundLeaves", message: mrkdwn });
      }
    });
  }

  enqueueRootBundleProposal(
    hubPoolChainId: number,
    bundleBlockRange: number[][],
    poolRebalanceLeaves: PoolRebalanceLeaf[],
    poolRebalanceRoot: string,
    relayerRefundLeaves: RelayerRefundLeaf[],
    relayerRefundRoot: string,
    slowRelayLeaves: V3SlowFillLeaf[],
    slowRelayRoot: string
  ): void {
    try {
      const bundleEndBlocks = bundleBlockRange.map((block) => block[1]);
      const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(bundleBlockRange[0][0]);
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.hubPoolClient.hubPool, // target contract
        chainId: hubPoolChainId,
        method: "proposeRootBundle", // method called.
        args: [bundleEndBlocks, poolRebalanceLeaves.length, poolRebalanceRoot, relayerRefundRoot, slowRelayRoot], // props sent with function call.
        message: "Proposed new root bundle 🌱", // message sent to logger.
        mrkdwn: PoolRebalanceUtils.generateMarkdownForRootBundle(
          this.clients.hubPoolClient,
          chainIds,
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

  _submitDisputeWithMrkdwn(hubPoolChainId: number, mrkdwn: string): void {
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
    blockRangesForChains: number[][],
    latestMainnetBlock: number,
    mainnetBundleEndBlock: number,
    bundleV3Deposits: BundleDepositsV3,
    bundleV3Fills: BundleFillsV3,
    bundleSlowFills: BundleSlowFills,
    unexecutableSlowFills: BundleExcessSlowFills,
    expiredDepositsToRefundV3: ExpiredDepositsToRefundV3
  ): Promise<PoolRebalanceRoot> {
    const key = JSON.stringify(blockRangesForChains);
    // FIXME: Temporary fix to disable root cache rebalancing and to keep the
    //        executor running for tonight (2023-08-28) until we can fix the
    //        root cache rebalancing bug.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    if (!this.rootCache[key] || process.env.DATAWORKER_DISABLE_REBALANCE_ROOT_CACHE === "true") {
      this.rootCache[key] = _buildPoolRebalanceRoot(
        latestMainnetBlock,
        mainnetBundleEndBlock,
        bundleV3Deposits,
        bundleV3Fills,
        bundleSlowFills,
        unexecutableSlowFills,
        expiredDepositsToRefundV3,
        this.clients,
        this.maxL1TokenCountOverride
      );
    }

    return _.cloneDeep(await this.rootCache[key]);
  }

  _getRequiredEthForArbitrumPoolRebalanceLeaf(leaf: PoolRebalanceLeaf): BigNumber {
    // For arbitrum, the bot needs enough ETH to pay for each L1 -> L2 message.
    // The following executions trigger an L1 -> L2 message:
    // 1. The first arbitrum leaf for a particular set of roots. This means the roots must be sent and is
    //    signified by groupIndex === 0.
    // 2. Any netSendAmount > 0 triggers an L1 -> L2 token send, which costs 0.02 ETH.
    let requiredAmount = leaf.netSendAmounts.reduce(
      (acc, curr) => (curr.gt(0) ? acc.add(toBNWei("0.02")) : acc),
      BigNumber.from(0)
    );

    if (leaf.groupIndex === 0) {
      requiredAmount = requiredAmount.add(toBNWei("0.02"));
    }
    return requiredAmount;
  }

  /**
   * Retrieves the amount of ETH required to execute a Linea relay leaf by querying the latest
   * relay fee from the L2Linea Messenger contract.
   * @param leaf The relay leaf to execute. Used in this function to prevent non-Linea chains from calling this method.
   * @returns The amount of ETH required to execute the relay leaf.
   * @throws If the method is called using a non-linea spoke pool client.
   */
  _getRequiredEthForLineaRelayLeafExecution(client: SpokePoolClient): Promise<BigNumber> {
    // You should *only* call this method on Linea chains.
    assert(sdkUtils.chainIsLinea(client.chainId), "This method should only be called on Linea chains!");
    // Resolve and sanitize the L2MessageService contract ABI and address.
    const l2MessageABI = CONTRACT_ADDRESSES[client.chainId]?.l2MessageService?.abi;
    const l2MessageAddress = CONTRACT_ADDRESSES[client.chainId]?.l2MessageService?.address;
    assert(isDefined(l2MessageABI), "L2MessageService contract ABI is not defined for Linea chain!");
    assert(isDefined(l2MessageAddress), "L2MessageService contract address is not defined for Linea chain!");
    // For Linea, the bot needs enough ETH to pay for each L2 -> L1 message.
    const l2MessagerContract = new Contract(l2MessageAddress, l2MessageABI, client.spokePool.provider);
    // Get the latest relay fee from the L2Linea Messenger contract.
    return l2MessagerContract.minimumFeeInWei();
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

  /**
   * Returns widest possible block range for next bundle.
   * @param spokePoolClients SpokePool clients to query. If one is undefined then the chain ID will be treated as
   * disabled.
   * @param mainnetBundleStartBlock Passed in to determine which disabled chain list to use (i.e. the list that is live
   * at the time of this block). Also used to determine which chain ID indices list to use which is the max
   * set of chains we can return block ranges for.
   * @returns [number, number]: [startBlock, endBlock]
   */
  _getWidestPossibleBlockRangeForNextBundle(
    spokePoolClients: SpokePoolClientsByChain,
    mainnetBundleStartBlock: number
  ): number[][] {
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(mainnetBundleStartBlock);
    return PoolRebalanceUtils.getWidestPossibleExpectedBlockRange(
      // We only want as many block ranges as there are chains enabled at the time of the bundle start block.
      chainIds,
      spokePoolClients,
      getEndBlockBuffers(chainIds, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockSearched,
      // We only want to count enabled chains at the same time that we are loading chain ID indices.
      this.clients.configStoreClient.getEnabledChains(mainnetBundleStartBlock)
    );
  }
}
