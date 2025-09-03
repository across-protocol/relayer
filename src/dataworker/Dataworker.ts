import assert from "assert";
import { Contract } from "ethers";
import { utils as sdkUtils, arch } from "@across-protocol/sdk";
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
  ZERO_BYTES,
  chainIsMatic,
  CHAIN_IDs,
  getWidestPossibleExpectedBlockRange,
  getEndBlockBuffers,
  _buildPoolRebalanceRoot,
  ERC20,
  getTokenInfo,
  isEVMSpokePoolClient,
  isSVMSpokePoolClient,
  Address,
  EvmAddress,
  toAddressType,
  getKitKeypairFromEvmSigner,
  getEventAuthority,
  getStatePda,
  getFillStatusPda,
  LatestBlockhash,
  getRelayDataHash,
  sendAndConfirmSolanaTransaction,
  SvmAddress,
  getInstructionParamsPda,
  getRootBundlePda,
  getTransferLiabilityPda,
  getAssociatedTokenAddress,
  toSvmRelayerRefundLeaf,
  toSvmSlowFillLeaf,
  forEachAsync,
  convertRelayDataParamsToBytes32,
  convertRelayDataParamsToNative,
  convertFillParamsToNative,
  mapAsync,
  getAccountMeta,
  getClaimAccountPda,
  chainIsSvm,
  getAddressLookupTableInstructions,
  waitForNewSolanaBlock,
  toKitAddress,
  createDefaultTransaction,
} from "../utils";
import {
  ProposedRootBundle,
  RootBundleRelayWithBlock,
  SpokePoolClientsByChain,
  PendingRootBundle,
  RunningBalances,
  PoolRebalanceLeaf,
  RelayerRefundLeaf,
  SlowFillLeaf,
  FillStatus,
  ConvertedRelayData,
} from "../interfaces";
import { DataworkerConfig } from "./DataworkerConfig";
import { DataworkerClients } from "./DataworkerClientHelper";
import {
  SpokePoolClient,
  BalanceAllocator,
  BundleDataClient,
  SVMSpokePoolClient,
  EVMSpokePoolClient,
} from "../clients";
import * as PoolRebalanceUtils from "./PoolRebalanceUtils";
import {
  blockRangesAreInvalidForSpokeClients,
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
  InvalidBlockRange,
  l2TokensToCountTowardsSpokePoolLeafExecutionCapital,
  persistDataToArweave,
} from "../dataworker/DataworkerUtils";
import { _buildRelayerRefundRoot, _buildSlowRelayRoot } from "./DataworkerUtils";
import _ from "lodash";
import {
  ARBITRUM_ORBIT_L1L2_MESSAGE_FEE_DATA,
  CONTRACT_ADDRESSES,
  IOFT_ABI_FULL,
  spokePoolClientsToProviders,
} from "../common";
import * as OFT from "../utils/OFTUtils";
import * as sdk from "@across-protocol/sdk";
import {
  BundleData,
  BundleDepositsV3,
  BundleExcessSlowFills,
  BundleFillsV3,
  BundleSlowFills,
  ExpiredDepositsToRefundV3,
} from "../interfaces/BundleData";
import {
  address,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  pipe,
  some,
  fetchEncodedAccount,
  compressTransactionMessageUsingAddressLookupTables,
  type Address as KitAddress,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { SvmSpokeClient } from "@across-protocol/contracts";
import {
  findAddressLookupTablePda,
  getCreateLookupTableInstruction,
  getDeactivateLookupTableInstruction,
} from "@solana-program/address-lookup-table";

// Internal error reasons for labeling a pending root bundle as "invalid" that we don't want to submit a dispute
// for. These errors are due to issues with the dataworker configuration, instead of with the pending root
// bundle. Any reasons in IGNORE_X we emit a "debug" level log for, and any reasons in ERROR_X we emit an "error"
// level log for.
const IGNORE_DISPUTE_REASONS = new Set(["bundle-end-block-buffer"]);
const ERROR_DISPUTE_REASONS = new Set(["insufficient-dataworker-lookback", "out-of-date-config-store-version"]);

// When executing Solana leaves, we need to write data to the `instruction_params` PDA. Empirically, the maximum amount we can write per
// instruction is 900 bytes.
const INSTRUCTION_PARAMS_MAX_WRITE_SIZE = 900;

const { getMessageHash, getRelayEventKey } = sdkUtils;

// Create a type for storing a collection of roots
type SlowRootBundle = {
  leaves: SlowFillLeaf[];
  tree: MerkleTree<SlowFillLeaf>;
};

type ProposeRootBundleReturnType = {
  poolRebalanceLeaves: PoolRebalanceLeaf[];
  poolRebalanceTree: MerkleTree<PoolRebalanceLeaf>;
  relayerRefundLeaves: RelayerRefundLeaf[];
  relayerRefundTree: MerkleTree<RelayerRefundLeaf>;
  slowFillLeaves: SlowFillLeaf[];
  slowFillTree: MerkleTree<SlowFillLeaf>;
  bundleData: BundleData;
};

export type PoolRebalanceRoot = {
  runningBalances: RunningBalances;
  realizedLpFees: RunningBalances;
  leaves: PoolRebalanceLeaf[];
  tree: MerkleTree<PoolRebalanceLeaf>;
};

type PoolRebalanceRootCache = Record<string, PoolRebalanceRoot>;

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  rootCache: PoolRebalanceRootCache = {};

  blockRangeEndBlockBuffer: { [chainId: number]: number };

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly config: DataworkerConfig,
    readonly clients: DataworkerClients,
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly maxRefundCountOverride: number | undefined,
    readonly maxL1TokenCountOverride: number | undefined,
    readonly spokeRootsLookbackCount = 0,
    readonly bufferToPropose = 0,
    readonly forceProposal = false,
    readonly forceBundleRange?: [number, number][]
  ) {
    this.blockRangeEndBlockBuffer = clients.bundleDataClient.blockRangeEndBlockBuffer;
    if (
      maxRefundCountOverride !== undefined ||
      maxL1TokenCountOverride !== undefined ||
      Object.keys(this.blockRangeEndBlockBuffer).length > 0
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

    return this._getPoolRebalanceRoot(
      spokePoolClients,
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
      this.clients.hubPoolClient.latestHeightSearched
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
        mostRecentProposedRootBundle: mostRecentProposedRootBundle.txnRef,
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
        mostRecentProposedRootBundle: mostRecentProposedRootBundle.txnRef,
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
    if (!this.forceProposal && !this.config.awaitChallengePeriod && hubPoolClient.hasPendingProposal()) {
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
    const nextBundleMainnetStartBlock = this.getOptimisticChainBundleStartBlock();
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(nextBundleMainnetStartBlock);
    const blockRangesForProposal = await this._getWidestPossibleBlockRangeForNextBundle(
      spokePoolClients,
      nextBundleMainnetStartBlock,
      true
    );

    // Exit early if spoke pool clients don't have early enough event data to satisfy block ranges for the
    // potential proposal
    const invalidBlockRanges = await this._validateBlockRanges(
      spokePoolClients,
      blockRangesForProposal,
      chainIds,
      earliestBlocksInSpokePoolClients
    );
    if (invalidBlockRanges.length > 0) {
      this.logger.warn({
        at: "Dataworker#propose",
        message: "Cannot propose bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
        invalidBlockRanges,
        bundleBlockRanges: this._prettifyBundleBlockRanges(chainIds, blockRangesForProposal),
      });
      return;
    }

    return blockRangesForProposal;
  }

  getNextHubChainBundleStartBlock(chainIdList = this.chainIdListForBundleEvaluationBlockNumbers): number {
    const hubPoolClient = this.clients.hubPoolClient;
    return hubPoolClient.getNextBundleStartBlockNumber(
      chainIdList,
      hubPoolClient.latestHeightSearched,
      hubPoolClient.chainId
    );
  }

  getOptimisticChainBundleStartBlock(chainIdList = this.chainIdListForBundleEvaluationBlockNumbers): number {
    const hubPoolClient = this.clients.hubPoolClient;
    return hubPoolClient.getOptimisticBundleStartBlockNumber(
      chainIdList,
      hubPoolClient.latestHeightSearched,
      hubPoolClient.chainId
    );
  }

  /**
   * @returns bundle data if new proposal transaction is enqueued, else undefined
   */
  async proposeRootBundle(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<BundleData> {
    const submitProposals = this.config.sendingTransactionsEnabled;

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

    const { chainId: hubPoolChainId, latestHeightSearched } = this.clients.hubPoolClient;
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
      latestHeightSearched,
      false, // Don't load data from arweave when proposing.
      logData
    );

    // TODO: Validate running balances in potential new bundle and make sure that important invariants
    // are not violated, such as a token balance being lower than the amount necessary to pay out all refunds,
    // slow fills, and return funds to the HubPool. Can use logic similar to src/scripts/validateRunningBalances.ts

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
      message: "Enqueuing new root bundle proposal txn",
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
    return rootBundleData.bundleData;
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
    const bundleData = {
      bundleBlockRanges: blockRangesForProposal,
      bundleDepositsV3,
      expiredDepositsToRefundV3,
      bundleFillsV3,
      unexecutableSlowFills,
      bundleSlowFillsV3,
    };
    const [, mainnetBundleEndBlock] = blockRangesForProposal[0];

    const poolRebalanceRoot = await this._getPoolRebalanceRoot(
      spokePoolClients,
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
      bundleData,
    };
  }

  async validatePendingRootBundle(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<void> {
    const persistBundleData = this.config.persistingBundleData;
    const submitDisputes = this.config.sendingTransactionsEnabled;
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
      pendingRootBundle: {
        ...pendingRootBundle,
        proposer: pendingRootBundle.proposer.toNative(),
      },
    });

    // Exit early if challenge period timestamp has passed:
    if (this.clients.hubPoolClient.currentTime > pendingRootBundle.challengePeriodEndTimestamp) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Challenge period passed, cannot dispute",
        expirationTime: pendingRootBundle.challengePeriodEndTimestamp,
      });
      return;
    }

    const nextBundleMainnetStartBlock = this.getNextHubChainBundleStartBlock();
    const widestPossibleExpectedBlockRange = await this._getWidestPossibleBlockRangeForNextBundle(
      spokePoolClients,
      // Mainnet bundle start block for pending bundle is the first entry in the first entry.
      nextBundleMainnetStartBlock
    );
    const { valid, reason, bundleData, expectedTrees } = await this.validateRootBundle(
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

    // Root bundle is valid, attempt to persist the raw bundle data and the merkle leaf data to DA layer
    // if not already there.
    if (persistBundleData && isDefined(bundleData)) {
      const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(nextBundleMainnetStartBlock);
      // Store the bundle block ranges on Arweave as a map of chainId to block range to aid users in querying.
      const bundleBlockRangeMap = Object.fromEntries(
        bundleData.bundleBlockRanges.map((range, i) => {
          const chainIdForRange = chainIds[i];
          return [chainIdForRange, range];
        })
      );
      // As a unique key for this bundle, use the next bundle mainnet start block, which should
      // never be duplicated between bundles as long as the mainnet end block in the bundle block range
      // always progresses forwards, which I think is a safe assumption. Other chains might pause
      // but mainnet should never pause.
      const partialArweaveDataKey = BundleDataClient.getArweaveClientKey(bundleData.bundleBlockRanges);
      await Promise.all([
        persistDataToArweave(
          this.clients.arweaveClient,
          {
            bundleDepositsV3: Object.fromEntries(
              Object.entries(bundleData.bundleDepositsV3).map(([chainId, tokenToDeposits]) => [
                chainId,
                Object.fromEntries(
                  Object.entries(tokenToDeposits).map(([token, deposits]) => [
                    token,
                    deposits.map(convertRelayDataParamsToNative),
                  ])
                ),
              ])
            ),
            expiredDepositsToRefundV3: Object.fromEntries(
              Object.entries(bundleData.expiredDepositsToRefundV3).map(([chainId, tokenToDeposits]) => [
                chainId,
                Object.fromEntries(
                  Object.entries(tokenToDeposits).map(([token, deposits]) => [
                    token,
                    deposits.map(convertRelayDataParamsToNative),
                  ])
                ),
              ])
            ),
            bundleFillsV3: Object.fromEntries(
              Object.entries(bundleData.bundleFillsV3).map(([chainId, tokenToFills]) => [
                chainId,
                Object.fromEntries(
                  Object.entries(tokenToFills).map(([token, fillObject]) => [
                    token,
                    {
                      ...fillObject,
                      fills: fillObject.fills.map(convertFillParamsToNative),
                    },
                  ])
                ),
              ])
            ),
            unexecutableSlowFills: Object.fromEntries(
              Object.entries(bundleData.unexecutableSlowFills).map(([chainId, tokenToSlowFills]) => [
                chainId,
                Object.fromEntries(
                  Object.entries(tokenToSlowFills).map(([token, slowFills]) => [
                    token,
                    slowFills.map(convertRelayDataParamsToNative),
                  ])
                ),
              ])
            ),
            bundleSlowFillsV3: Object.fromEntries(
              Object.entries(bundleData.bundleSlowFillsV3).map(([chainId, tokenToSlowFills]) => [
                chainId,
                Object.fromEntries(
                  Object.entries(tokenToSlowFills).map(([token, slowFills]) => [
                    token,
                    slowFills.map(convertRelayDataParamsToNative),
                  ])
                ),
              ])
            ),
            bundleBlockRanges: bundleBlockRangeMap,
          },
          this.logger,
          `bundles-${partialArweaveDataKey}`
        ),
        persistDataToArweave(
          this.clients.arweaveClient,
          {
            bundleBlockRanges: bundleBlockRangeMap,
            poolRebalanceLeaves: expectedTrees.poolRebalanceTree.leaves.map((leaf) => {
              return {
                ...leaf,
                l1Tokens: leaf.l1Tokens.map((l1Token) => l1Token.toBytes32()),
                proof: expectedTrees.poolRebalanceTree.tree.getHexProof(leaf),
              };
            }),
            poolRebalanceRoot: expectedTrees.poolRebalanceTree.tree.getHexRoot(),
            relayerRefundLeaves: expectedTrees.relayerRefundTree.leaves.map((leaf) => {
              return {
                ...leaf,
                l2TokenAddress: leaf.l2TokenAddress.toBytes32(),
                refundAddresses: leaf.refundAddresses.map((refundAddress) => refundAddress.toBytes32()),
                proof: expectedTrees.relayerRefundTree.tree.getHexProof(leaf),
              };
            }),
            relayerRefundRoot: expectedTrees.relayerRefundTree.tree.getHexRoot(),
            slowRelayLeaves: expectedTrees.slowRelayTree.leaves.map((leaf) => {
              return {
                ...leaf,
                relayData: convertRelayDataParamsToNative(leaf.relayData),
                proof: expectedTrees.slowRelayTree.tree.getHexProof(leaf),
              };
            }),
            slowRelayRoot: expectedTrees.slowRelayTree.tree.getHexRoot(),
          },
          this.logger,
          `merkletree-${partialArweaveDataKey}`
        ),
      ]);
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
            tree: MerkleTree<SlowFillLeaf>;
            leaves: SlowFillLeaf[];
          };
        };
        bundleData?: BundleData;
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
            tree: MerkleTree<SlowFillLeaf>;
            leaves: SlowFillLeaf[];
          };
        };
        bundleData: BundleData;
      }
  > {
    // If pool rebalance root is empty, always dispute. There should never be a bundle with an empty rebalance root.
    if (rootBundle.poolRebalanceRoot === EMPTY_MERKLE_ROOT) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Empty pool rebalance root, submitting dispute",
        rootBundle: {
          ...rootBundle,
          proposer: rootBundle.proposer.toNative(),
        },
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

    const blockRangesImpliedByBundleEndBlocks = widestPossibleExpectedBlockRange.map((blockRange, index) => {
      // Block ranges must be coherent; otherwise the chain is soft-paused.
      const [startBlock, endBlock] = [blockRange[0], rootBundle.bundleEvaluationBlockNumbers[index]];
      return endBlock > startBlock ? [startBlock, endBlock] : [endBlock, endBlock];
    });

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
    const invalidBlockRanges = await this._validateBlockRanges(
      spokePoolClients,
      blockRangesImpliedByBundleEndBlocks,
      chainIds,
      earliestBlocksInSpokePoolClients
    );
    if (invalidBlockRanges.length > 0) {
      this.logger.warn({
        at: "Dataworker#validate",
        message: "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
        invalidBlockRanges,
        bundleBlockRanges: this._prettifyBundleBlockRanges(chainIds, blockRangesImpliedByBundleEndBlocks),
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
        expectedPoolRebalanceLeaves: expectedPoolRebalanceRoot.leaves.map((leaf) => {
          return {
            ...leaf,
            l1Tokens: leaf.l1Tokens.map((l1Token) => l1Token.toNative()),
          };
        }),
        expectedPoolRebalanceRoot: expectedPoolRebalanceRoot.tree.getHexRoot(),
        expectedRelayerRefundLeaves: expectedRelayerRefundRoot.leaves.map((leaf) => {
          return {
            ...leaf,
            l2TokenAddress: leaf.l2TokenAddress.toNative(),
            refundAddresses: leaf.refundAddresses.map((refundAddress) => refundAddress.toNative()),
          };
        }),
        expectedRelayerRefundRoot: expectedRelayerRefundRoot.tree.getHexRoot(),
        expectedSlowRelayLeaves: expectedSlowRelayRoot.leaves.map((leaf) => {
          return {
            ...leaf,
            depositor: leaf.relayData.depositor.toNative(),
            recipient: leaf.relayData.recipient.toNative(),
            inputToken: leaf.relayData.inputToken.toNative(),
            outputToken: leaf.relayData.outputToken.toNative(),
            exclusiveRelayer: leaf.relayData.exclusiveRelayer.toNative(),
          };
        }),
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
        bundleData: rootBundleData.bundleData,
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
        if (this.config.executorIgnoreChains.includes(chainId)) {
          return;
        }

        let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter(
          (rootBundle) => rootBundle.blockNumber >= client.eventSearchConfig.from
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
              this.clients.hubPoolClient.latestHeightSearched;

            if (!followingBlockNumber) {
              return false;
            }

            const leaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);

            // Only use this bundle if it had valid leaves returned (meaning it was at least partially executed).
            return leaves.length > 0;
          });

          if (!matchingRootBundle) {
            this.logger.warn({
              at: "Dataworker#executeSlowRelayLeaves",
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
          const invalidBlockRanges = await this._validateBlockRanges(
            spokePoolClients,
            blockNumberRanges,
            chainIds,
            earliestBlocksInSpokePoolClients
          );
          if (invalidBlockRanges.length > 0) {
            this.logger.warn({
              at: "Dataworker#executeSlowRelayLeaves",
              message:
                "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
              invalidBlockRanges,
              bundleTxn: matchingRootBundle.txnRef,
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
              at: "Dataworker#executeSlowRelayLeaves",
              message: "Constructed a different root for the block range!",
              chainId,
              rootBundleRelay,
              mainnetRootBundleBlock: matchingRootBundle.blockNumber,
              mainnetRootBundleTxn: matchingRootBundle.txnRef,
              publishedSlowRelayRoot: rootBundleRelay.slowRelayRoot,
              constructedSlowRelayRoot: tree.getHexRoot(),
            });
            continue;
          }

          const unexecutedLeaves = leaves.filter((leaf) => {
            // Filter out slow fill leaves for other chains.
            if (leaf.chainId !== chainId) {
              return false;
            }
            const executedLeaf = slowFillsForChain.find(
              (event) =>
                event.originChainId === leaf.relayData.originChainId && event.depositId.eq(leaf.relayData.depositId)
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
            rootBundleRelay.rootBundleId
          );
        }
      })
    );
  }

  async _executeSlowFillLeaf(
    _leaves: SlowFillLeaf[],
    balanceAllocator: BalanceAllocator,
    client: SpokePoolClient,
    slowRelayTree: MerkleTree<SlowFillLeaf>,
    rootBundleId?: number
  ): Promise<void> {
    const submitExecution = this.config.sendingTransactionsEnabled;
    const currentTime = client.getCurrentTime();

    // Ignore slow fill leaves for deposits with messages as these messages might be very expensive to execute.
    // The original depositor can always execute these and pay for the gas themselves.
    const leaves = _leaves.filter((leaf) => {
      const {
        relayData: { depositor, recipient, message, fillDeadline },
      } = leaf;

      if (fillDeadline < currentTime) {
        this.logger.debug({
          at: "Dataworker#_executeSlowFillLeaf",
          message: "Ignoring slow fill leaf with expired fill deadline",
          fillDeadline,
          currentTime,
        });
        return false;
      }

      // If there is a message, we ignore the leaf and log an error.
      if (!sdk.utils.isMessageEmpty(message)) {
        const { method, args } = this.encodeSlowFillLeaf(slowRelayTree, rootBundleId, leaf);

        this.logger.warn({
          at: "Dataworker#_executeSlowFillLeaf",
          message: "Ignoring slow fill leaf with message",
          method,
          args,
        });
        return false;
      }

      const { addressFilter } = this.config;
      if (addressFilter?.has(depositor.toNative()) || addressFilter?.has(recipient.toNative())) {
        this.logger.warn({
          at: "Dataworker#_executeSlowFillLeaf",
          message: "Ignoring slow fill.",
          leafExecutionArgs: [depositor.toNative(), recipient.toNative()],
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
      const { relayData, chainId: destinationChainId } = slowFill;
      const messageHash = getMessageHash(relayData.message);

      // Start with the most recent fills and search backwards.
      const fill = _.findLast(
        sortedFills,
        (fill) =>
          fill.depositId.eq(relayData.depositId) &&
          fill.originChainId === relayData.originChainId &&
          getRelayEventKey(fill) === getRelayEventKey({ ...relayData, messageHash, destinationChainId })
      );

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
          const fillStatus = await client.relayFillStatus(slowFill.relayData);
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
          const holder = chainIsSvm(destinationChainId)
            ? SvmAddress.from(await getStatePda(arch.svm.toAddress(client.spokePoolAddress)))
            : client.spokePoolAddress;
          const success = await balanceAllocator.requestBalanceAllocation(
            destinationChainId,
            l2TokensToCountTowardsSpokePoolLeafExecutionCapital(outputToken, destinationChainId),
            holder,
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
              token: outputToken.toNative(),
              amount: outputAmount,
              spokeBalance: await this._getSpokeBalanceForL2Tokens(
                balanceAllocator,
                destinationChainId,
                outputToken,
                client.spokePoolAddress
              ),
            });
          }

          // Assume we don't need to add balance in the BalanceAllocator to the HubPool because the slow fill's
          // recipient wouldn't be the HubPool in normal circumstances.
          return success ? slowFill : undefined;
        })
      )
    ).filter(isDefined);

    const hubChainId = this.clients.hubPoolClient.chainId;
    await forEachAsync(fundedLeaves, async (leaf) => {
      assert(leaf.chainId === chainId);

      const { relayData } = leaf;
      const { outputAmount } = relayData;
      const mrkdwn =
        `rootBundleId: ${rootBundleId}\n` +
        `slowRelayRoot: ${slowRelayTree.getHexRoot()}\n` +
        `Origin chain: ${relayData.originChainId}\n` +
        `Destination chain:${chainId}\n` +
        `Deposit Id: ${relayData.depositId.toString()}\n` +
        `amount: ${outputAmount.toString()}`;

      if (submitExecution) {
        if (isEVMSpokePoolClient(client)) {
          const { method, args } = this.encodeSlowFillLeaf(slowRelayTree, rootBundleId, leaf);

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
          assert(isSVMSpokePoolClient(client));
          const signature = await this._executeSlowFillLeafSvm(
            client,
            leaf,
            rootBundleId,
            slowRelayTree.getHexProof(leaf)
          );
          this.logger.info({ at: "Dataworker#executeSlowRelayLeaves", message: mrkdwn, signature });
        }
      } else {
        this.logger.debug({ at: "Dataworker#executeSlowRelayLeaves", message: mrkdwn });
      }
    });
  }

  encodeSlowFillLeaf(
    slowRelayTree: MerkleTree<SlowFillLeaf>,
    rootBundleId: number,
    leaf: SlowFillLeaf
  ): {
    method: string;
    args: (number | string[] | { relayData: ConvertedRelayData; chainId: number; updatedOutputAmount: BigNumber })[];
  } {
    const method = "executeSlowRelayLeaf";
    const proof = slowRelayTree.getHexProof(leaf);
    const relayDataWithBytes32Params = convertRelayDataParamsToBytes32(leaf.relayData);
    const args = [
      {
        ...leaf,
        relayData: relayDataWithBytes32Params,
      },
      rootBundleId,
      proof,
    ];

    return { method, args };
  }

  /**
   * @notice Executes outstanding pool rebalance leaves if they have passed the challenge window. Includes
   * exchange rate updates needed to execute leaves.
   * @param spokePoolClients
   * @param balanceAllocator
   * @param earliestBlocksInSpokePoolClients
   * @returns number of leaves executed
   */
  async executePoolRebalanceLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients)),
    earliestBlocksInSpokePoolClients: { [chainId: number]: number } = {}
  ): Promise<number> {
    const leafCount = 0;
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
      hubPoolCurrentTime: this.clients.hubPoolClient.currentTime,
      pendingRootBundle: {
        ...pendingRootBundle,
        proposer: pendingRootBundle.proposer.toNative(),
      },
    });

    const nextBundleMainnetStartBlock = this.getNextHubChainBundleStartBlock();
    const widestPossibleExpectedBlockRange = await this._getWidestPossibleBlockRangeForNextBundle(
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
    if (
      !this.config.awaitChallengePeriod &&
      this.clients.hubPoolClient.currentTime <= pendingRootBundle.challengePeriodEndTimestamp
    ) {
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
      this.clients.hubPoolClient.latestHeightSearched
    );

    // Filter out previously executed leaves.
    const unexecutedLeaves = expectedTrees.poolRebalanceTree.leaves.filter((leaf) =>
      executedLeaves.every(({ leafId }) => leafId !== leaf.leafId)
    );
    if (unexecutedLeaves.length === 0) {
      return leafCount;
    }

    return this._executePoolLeavesAndSyncL1Tokens(
      spokePoolClients,
      balanceAllocator,
      unexecutedLeaves,
      expectedTrees.poolRebalanceTree.tree,
      expectedTrees.relayerRefundTree.leaves,
      expectedTrees.relayerRefundTree.tree,
      expectedTrees.slowRelayTree.leaves,
      expectedTrees.slowRelayTree.tree
    );
  }

  async _executePoolLeavesAndSyncL1Tokens(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator,
    poolLeaves: PoolRebalanceLeaf[],
    poolRebalanceTree: MerkleTree<PoolRebalanceLeaf>,
    relayerRefundLeaves: RelayerRefundLeaf[],
    relayerRefundTree: MerkleTree<RelayerRefundLeaf>,
    slowFillLeaves: SlowFillLeaf[],
    slowFillTree: MerkleTree<SlowFillLeaf>
  ): Promise<number> {
    const hubPoolChainId = this.clients.hubPoolClient.chainId;

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

    // Keep track of the HubPool.pooledTokens.liquidReserves state value before entering into any possible
    // LP token update. This way we can efficiently update LP liquid reserves values if and only if we need to do so
    // to execute a pool leaf.
    let latestLiquidReserves: Record<string, BigNumber> = {};
    let leafCount = 0;

    // First, execute mainnet pool rebalance leaves. Then try to execute any relayer refund and slow leaves for the
    // expected relayed root hash, then proceed with remaining pool rebalance leaves. This is an optimization that
    // takes advantage of the fact that mainnet transfers between HubPool and SpokePool are atomic.
    const mainnetLeaves = poolLeaves.filter((leaf) => leaf.chainId === hubPoolChainId);
    if (mainnetLeaves.length > 0) {
      assert(mainnetLeaves.length === 1, "There should only be one Ethereum PoolRebalanceLeaf");
      latestLiquidReserves = await this._updateExchangeRatesBeforeExecutingHubChainLeaves(
        balanceAllocator,
        mainnetLeaves[0]
      );
      leafCount += await this._executePoolRebalanceLeaves(
        spokePoolClients,
        mainnetLeaves,
        balanceAllocator,
        poolRebalanceTree
      );

      // We need to know the next root bundle ID for the mainnet spoke pool in order to execute leaves for roots that
      // will be relayed after executing the above pool rebalance root.
      const nextRootBundleIdForMainnet = spokePoolClients[hubPoolChainId].getLatestRootBundleId();

      // Now, execute refund and slow fill leaves for Mainnet using any new funds. These methods will return early if there
      // are no relevant leaves to execute.
      await this._executeSlowFillLeaf(
        slowFillLeaves.filter((leaf) => leaf.chainId === hubPoolChainId),
        balanceAllocator,
        spokePoolClients[hubPoolChainId],
        slowFillTree,
        nextRootBundleIdForMainnet
      );
      await this._executeRelayerRefundLeaves(
        relayerRefundLeaves.filter((leaf) => leaf.chainId === hubPoolChainId),
        balanceAllocator,
        spokePoolClients[hubPoolChainId],
        relayerRefundTree,
        nextRootBundleIdForMainnet
      );
    }

    // Before executing the other pool rebalance leaves, see if we should update any exchange rates to account for
    // any tokens returned to the hub pool via the EthereumSpokePool that we'll need to use to execute
    // any of the remaining pool rebalance leaves. This is also important if we failed to execute
    // the mainnet leaf and haven't enqueued a sync call that could be used to execute some of the other leaves.
    const nonHubChainPoolRebalanceLeaves = poolLeaves.filter((leaf) => leaf.chainId !== hubPoolChainId);
    if (nonHubChainPoolRebalanceLeaves.length === 0) {
      return leafCount;
    }
    const syncedL1Tokens = await this._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
      latestLiquidReserves,
      balanceAllocator,
      nonHubChainPoolRebalanceLeaves
    );
    Object.keys(latestLiquidReserves).forEach((token) => {
      if (!syncedL1Tokens.has(token)) {
        syncedL1Tokens.add(token);
      }
    });

    // Save all L1 tokens that we haven't updated exchange rates for in a different step.
    const l1TokensWithPotentiallyOlderUpdate = poolLeaves.reduce((l1TokenSet, leaf) => {
      const currLeafL1Tokens = leaf.l1Tokens;
      currLeafL1Tokens.forEach((l1Token, i) => {
        if (
          leaf.netSendAmounts[i].gt(0) &&
          !l1TokenSet.some((token) => token.eq(l1Token)) &&
          !syncedL1Tokens.has(l1Token.toEvmAddress())
        ) {
          l1TokenSet.push(l1Token);
        }
      });
      return l1TokenSet;
    }, []);
    await this._updateOldExchangeRates(l1TokensWithPotentiallyOlderUpdate);

    // Figure out which non-mainnet pool rebalance leaves we can execute and execute them:
    leafCount += await this._executePoolRebalanceLeaves(
      spokePoolClients,
      nonHubChainPoolRebalanceLeaves,
      balanceAllocator,
      poolRebalanceTree
    );
    return leafCount;
  }

  async _getExecutablePoolRebalanceLeaves(
    poolLeaves: PoolRebalanceLeaf[],
    balanceAllocator: BalanceAllocator
  ): Promise<PoolRebalanceLeaf[]> {
    // We evaluate these leaves iteratively rather than in parallel so we can keep track
    // of the used balances after "executing" each leaf.
    const executableLeaves: PoolRebalanceLeaf[] = [];
    for (const leaf of poolLeaves) {
      // We can evaluate the l1 tokens within the leaf in parallel because we can assume
      // that there are not duplicate L1 tokens within the leaf.
      const isExecutable = await sdkUtils.everyAsync(leaf.l1Tokens, async (l1Token, i) => {
        const netSendAmountForLeaf = leaf.netSendAmounts[i];
        if (netSendAmountForLeaf.lte(0)) {
          return true;
        }
        const hubChainId = this.clients.hubPoolClient.chainId;
        const hubPoolAddress = toAddressType(
          this.clients.hubPoolClient.hubPool.address,
          this.clients.hubPoolClient.chainId
        );
        const success = await balanceAllocator.requestBalanceAllocation(
          hubChainId,
          [l1Token],
          hubPoolAddress,
          netSendAmountForLeaf
        );
        return success;
      });
      if (isExecutable) {
        executableLeaves.push(leaf);
      } else {
        this.logger.error({
          at: "Dataworker#_getExecutablePoolRebalanceLeaves",
          message: `Not enough funds to execute pool rebalance leaf for chain ${leaf.chainId}`,
          l1Tokens: leaf.l1Tokens.map((l1Token) => l1Token.toNative()),
          netSendAmounts: leaf.netSendAmounts,
        });
      }
    }
    return executableLeaves;
  }

  async _executePoolRebalanceLeaves(
    spokePoolClients: {
      [chainId: number]: SpokePoolClient;
    },
    allLeaves: PoolRebalanceLeaf[],
    balanceAllocator: BalanceAllocator,
    tree: MerkleTree<PoolRebalanceLeaf>
  ): Promise<number> {
    const submitExecution = this.config.sendingTransactionsEnabled;
    const hubPoolChainId = this.clients.hubPoolClient.chainId;
    const signer = this.clients.hubPoolClient.hubPool.signer;

    // Evaluate leaves iteratively because we will be modifying virtual balances and we want
    // to make sure we are getting the virtual balance computations correct.
    const fundedLeaves = await this._getExecutablePoolRebalanceLeaves(allLeaves, balanceAllocator);
    const executableLeaves: PoolRebalanceLeaf[] = [];
    for (const leaf of fundedLeaves) {
      // For orbit leaves we need to check if we have enough gas tokens to pay for the L1 to L2 message.
      if (!sdkUtils.chainIsArbitrum(leaf.chainId) && !sdkUtils.chainIsOrbit(leaf.chainId)) {
        executableLeaves.push(leaf);
        continue;
      }

      // Check if orbit leaf can be executed.
      const {
        amount: requiredAmount,
        token: feeToken,
        holder,
      } = await this._getRequiredEthForOrbitPoolRebalanceLeaf(leaf);
      const feeData = {
        tokens: [feeToken],
        amount: requiredAmount,
        chainId: hubPoolChainId,
      };
      const success = await balanceAllocator.requestBalanceAllocations([{ ...feeData, holder }]);
      if (!success) {
        this.logger.debug({
          at: "Dataworker#_executePoolRebalanceLeaves",
          message: `Loading more orbit gas token to pay for L1->L2 message submission fees to ${getNetworkName(
            leaf.chainId
          )} 📨!`,
          leaf: {
            ...leaf,
            l1Tokens: leaf.l1Tokens.map((l1Token) => l1Token.toNative()),
          },
          feeToken: feeToken.toNative(),
          requiredAmount,
        });
        if (submitExecution) {
          const canFund = await balanceAllocator.requestBalanceAllocations([
            { ...feeData, holder: toAddressType(await signer.getAddress(), hubPoolChainId) },
          ]);
          if (!canFund) {
            this.logger.error({
              at: "Dataworker#_executePoolRebalanceLeaves",
              message: `Failed to fund ${requiredAmount.toString()} of orbit gas token ${feeToken} for message to ${getNetworkName(
                leaf.chainId
              )}!`,
            });
            continue;
          }
          if (feeToken.toBytes32() === ZERO_BYTES) {
            this.clients.multiCallerClient.enqueueTransaction({
              contract: this.clients.hubPoolClient.hubPool,
              chainId: hubPoolChainId,
              method: "loadEthForL2Calls",
              args: [],
              message: `Loaded ETH for message to ${getNetworkName(leaf.chainId)} 📨!`,
              mrkdwn: `Root hash: ${tree.getHexRoot()}\nLeaf: ${leaf.leafId}\nChain: ${leaf.chainId}`,
              value: requiredAmount,
            });
          } else {
            // We can't call multicall() here because the feeToken is not guaranteed to be a Multicaller
            // contract and this is a permissioned function where the msg.sender needs to be the
            // feeToken balance owner, so we can't simply set `unpermissioned: true` to send it through the Multisender.
            // Instead, we need to set `nonMulticall: true` and avoid batch calling this transaction.
            this.clients.multiCallerClient.enqueueTransaction({
              contract: new Contract(feeToken.toEvmAddress(), ERC20.abi, signer),
              chainId: hubPoolChainId,
              nonMulticall: true,
              method: "transfer",
              args: [holder.toEvmAddress(), requiredAmount],
              message: `Loaded orbit gas token for message to ${getNetworkName(leaf.chainId)} 📨!`,
              mrkdwn: `Root hash: ${tree.getHexRoot()}\nLeaf: ${leaf.leafId}\nChain: ${leaf.chainId}`,
            });
          }
        }
      } else {
        this.logger.debug({
          at: "Dataworker#_executePoolRebalanceLeaves",
          message: `feePayer ${holder} has sufficient orbit gas token to pay for L1->L2 message submission fees to ${getNetworkName(
            leaf.chainId
          )}`,
          feeToken: feeToken.toNative(),
          requiredAmount,
          feePayerBalance: await balanceAllocator.getBalanceSubUsed(hubPoolChainId, feeToken, holder),
        });
      }
      executableLeaves.push(leaf);
    }

    // Execute the leaves:
    executableLeaves.forEach((leaf) => {
      // Add balances to spoke pool on mainnet since we know it will be sent atomically.
      if (leaf.chainId === hubPoolChainId) {
        leaf.netSendAmounts.forEach((amount, i) => {
          if (amount.gt(bnZero)) {
            balanceAllocator.addUsed(
              leaf.chainId,
              leaf.l1Tokens[i],
              spokePoolClients[leaf.chainId].spokePoolAddress,
              amount.mul(-1)
            );
          }
        });
      }
      const mrkdwn = `Root hash: ${tree.getHexRoot()}\nLeaf: ${leaf.leafId}\nChain: ${leaf.chainId}`;
      if (submitExecution) {
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
            leaf.l1Tokens.map((token) => token.toEvmAddress()),
            tree.getHexProof(leaf),
          ],
          message: `Executed PoolRebalanceLeaf for chain ${leaf.chainId} 🌿!`,
          mrkdwn,
          unpermissioned: true,
          // If simulating execution of leaves for non-mainnet chains, can fail as it may require funds to be returned
          // from relayer refund leaves.
          canFailInSimulation: leaf.chainId !== hubPoolChainId,
        });
      } else {
        this.logger.debug({ at: "Dataworker#_executePoolRebalanceLeaves", message: mrkdwn });
      }
    });

    return executableLeaves.length;
  }

  async _updateExchangeRatesBeforeExecutingHubChainLeaves(
    balanceAllocator: BalanceAllocator,
    poolRebalanceLeaf: Pick<PoolRebalanceLeaf, "netSendAmounts" | "l1Tokens">
  ): Promise<Record<string, BigNumber>> {
    const submitExecution = this.config.sendingTransactionsEnabled;
    const { hubPool, chainId } = this.clients.hubPoolClient;

    const updatedLiquidReserves: Record<string, BigNumber> = {};
    const { netSendAmounts, l1Tokens } = poolRebalanceLeaf;
    await sdk.utils.forEachAsync(l1Tokens, async (l1Token, idx) => {
      const currentLiquidReserves = this.clients.hubPoolClient.getLpTokenInfoForL1Token(l1Token)?.liquidReserves;
      updatedLiquidReserves[l1Token.toEvmAddress()] = currentLiquidReserves;
      assert(currentLiquidReserves !== undefined && currentLiquidReserves.gte(0), "Liquid reserves should be >= 0");
      const tokenSymbol = this.clients.hubPoolClient.getTokenInfoForL1Token(l1Token)?.symbol;

      // If netSendAmounts is negative, there is no need to update this exchange rate.
      if (netSendAmounts[idx].lte(0)) {
        return;
      }

      // If current liquid reserves can cover the netSendAmount, then there is no need to update the exchange rate.
      if (currentLiquidReserves.gte(netSendAmounts[idx])) {
        this.logger.debug({
          at: "Dataworker#_updateExchangeRatesBeforeExecutingHubChainLeaves",
          message: `Skipping exchange rate update for ${tokenSymbol} because current liquid reserves > netSendAmount for hubChain`,
          currentLiquidReserves,
          netSendAmount: netSendAmounts[idx],
          l1Token: l1Token.toNative(),
        });
        updatedLiquidReserves[l1Token.toEvmAddress()] = currentLiquidReserves.sub(netSendAmounts[idx]);
        return;
      }

      // @dev: post-sync liquid reserves should be equal to ERC20 balanceOf the HubPool.
      const postSyncLiquidReserves = await balanceAllocator.getBalanceSubUsed(
        chainId,
        l1Token,
        toAddressType(hubPool.address, chainId)
      );

      // If updated liquid reserves are not enough to cover the payment, then send an error log that
      // we're short on funds. Otherwise, enqueue a sync() call and then update the availableLiquidReserves.
      if (postSyncLiquidReserves.lt(netSendAmounts[idx])) {
        this.logger.warn({
          at: "Dataworker#_updateExchangeRatesBeforeExecutingHubChainLeaves",
          message: `Not enough funds to execute Ethereum pool rebalance leaf on HubPool for token: ${tokenSymbol}`,
          netSendAmount: netSendAmounts[idx],
          currentLiquidReserves,
          postSyncLiquidReserves,
        });
      } else {
        // At this point, we can assume that the liquid reserves increased post-sync so we'll enqueue an update.
        updatedLiquidReserves[l1Token.toEvmAddress()] = postSyncLiquidReserves.sub(netSendAmounts[idx]);
        this.logger.debug({
          at: "Dataworker#_updateExchangeRatesBeforeExecutingHubChainLeaves",
          message: `Updating exchange rate for ${tokenSymbol} because we need to update the liquid reserves of the contract to execute the hubChain poolRebalanceLeaf.`,
          netSendAmount: netSendAmounts[idx],
          currentLiquidReserves,
          postSyncLiquidReserves,
        });
        if (submitExecution) {
          this.clients.multiCallerClient.enqueueTransaction({
            contract: hubPool,
            chainId,
            method: "exchangeRateCurrent",
            args: [l1Token.toEvmAddress()],
            message: "Updated exchange rate ♻️!",
            mrkdwn: `Updated exchange rate for l1 token: ${tokenSymbol}`,
            unpermissioned: true,
          });
        }
      }
    });
    return updatedLiquidReserves;
  }

  async _updateExchangeRatesBeforeExecutingNonHubChainLeaves(
    latestLiquidReserves: Record<string, BigNumber>,
    balanceAllocator: BalanceAllocator,
    poolRebalanceLeaves: Pick<PoolRebalanceLeaf, "netSendAmounts" | "l1Tokens" | "chainId">[]
  ): Promise<Set<string>> {
    const submitExecution = this.config.sendingTransactionsEnabled;
    const updatedL1Tokens = new Set<string>();
    const { hubPool, chainId: hubPoolChainId } = this.clients.hubPoolClient;

    const aggregateNetSendAmounts: Record<string, BigNumber> = {};

    await sdkUtils.forEachAsync(poolRebalanceLeaves, async (leaf) => {
      await sdkUtils.forEachAsync(leaf.l1Tokens, async (l1Token, idx) => {
        aggregateNetSendAmounts[l1Token.toEvmAddress()] ??= bnZero;

        // If leaf's netSendAmount is negative, then we don't need to updateExchangeRates since the Hub will not
        // have a liquidity constraint because it won't be sending any tokens.
        if (leaf.netSendAmounts[idx].lte(0)) {
          return;
        }
        aggregateNetSendAmounts[l1Token.toEvmAddress()] = aggregateNetSendAmounts[l1Token.toEvmAddress()].add(
          leaf.netSendAmounts[idx]
        );
      });
    });

    // Now, go through each L1 token and see if we need to update the exchange rate for it.
    await sdkUtils.forEachAsync(Object.keys(aggregateNetSendAmounts), async (l1Token) => {
      const currHubPoolLiquidReserves =
        latestLiquidReserves[l1Token] ??
        this.clients.hubPoolClient.getLpTokenInfoForL1Token(EvmAddress.from(l1Token))?.liquidReserves;
      assert(
        currHubPoolLiquidReserves !== undefined && currHubPoolLiquidReserves.gte(0),
        "Liquid reserves should be >= 0"
      );

      const requiredNetSendAmountForL1Token = aggregateNetSendAmounts[l1Token];
      // If netSendAmounts is 0, there is no need to update this exchange rate.
      assert(requiredNetSendAmountForL1Token.gte(0), "Aggregate net send amount should be >= 0");
      if (requiredNetSendAmountForL1Token.eq(0)) {
        return;
      }

      const tokenSymbol = this.clients.hubPoolClient.getTokenInfoForL1Token(EvmAddress.from(l1Token))?.symbol;
      if (currHubPoolLiquidReserves.gte(requiredNetSendAmountForL1Token)) {
        this.logger.debug({
          at: "Dataworker#_updateExchangeRatesBeforeExecutingNonHubChainLeaves",
          message: `Skipping exchange rate update for ${tokenSymbol} because current liquid reserves > required netSendAmount for non-hubChain pool leaves`,
          leavesWithNetSendAmountRequirementsFromHubPoolLiquidReserves: Object.fromEntries(
            poolRebalanceLeaves
              .filter((leaf) => {
                const l1TokenIndex = leaf.l1Tokens.map((token) => token.toEvmAddress()).indexOf(l1Token);
                if (l1TokenIndex === -1) {
                  return false;
                }
                const netSendAmount = leaf.netSendAmounts[l1TokenIndex];
                return netSendAmount.gt(0);
              })
              .map((leaf) => [
                leaf.chainId,
                leaf.netSendAmounts[leaf.l1Tokens.map((token) => token.toEvmAddress()).indexOf(l1Token)],
              ])
          ),
          currHubPoolLiquidReserves,
          requiredNetSendAmountForL1Token,
          l1Token,
        });
        return;
      }

      // Current liquid reserves are insufficient to execute aggregate net send amount for this token so
      // look at the updated liquid reserves post-sync. This will be equal the ERC20 balanceOf the hub pool
      // including any netSendAmounts used in a prior pool leaf execution.
      const updatedLiquidReserves = await balanceAllocator.getBalanceSubUsed(
        hubPoolChainId,
        toAddressType(l1Token, hubPoolChainId),
        toAddressType(hubPool.address, hubPoolChainId)
      );

      // If the post-sync balance is still too low to execute all the pool leaves, then log an error
      if (updatedLiquidReserves.lt(requiredNetSendAmountForL1Token)) {
        this.logger.warn({
          at: "Dataworker#_updateExchangeRatesBeforeExecutingNonHubChainLeaves",
          message: `Not enough funds to execute ALL non-Ethereum pool rebalance leaf on HubPool for token: ${tokenSymbol}, updating exchange rate anyways to try to execute as many leaves as possible`,
          l1Token,
          requiredNetSendAmountForL1Token,
          currHubPoolLiquidReserves,
          updatedLiquidReserves,
        });
      } else {
        this.logger.debug({
          at: "Dataworker#_updateExchangeRatesBeforeExecutingNonHubChainLeaves",
          message: `Post-sync liquid reserves are sufficient to execute PoolRebalanceLeaf, updating exchange rate for ${tokenSymbol}`,
          l1Token,
          requiredNetSendAmountForL1Token,
          currHubPoolLiquidReserves,
          updatedLiquidReserves,
        });
      }

      // We don't know yet which leaves we can execute so we'll update the exchange rate for this token even if
      // some leaves might not be executable.
      // TODO: Be more precise about whether updating this l1 token is worth it. For example, if we update this l1
      // token and its reserves increase, depending on which other tokens are contained in the pool rebalance leaf
      // with this token, increasing this token's reserves might not help us execute those leaves.
      if (updatedLiquidReserves.gt(currHubPoolLiquidReserves)) {
        updatedL1Tokens.add(l1Token);
      } else {
        this.logger.debug({
          at: "Dataworker#_updateExchangeRatesBeforeExecutingNonHubChainLeaves",
          message: `Skipping exchange rate update for ${tokenSymbol} because liquid reserves would not increase`,
          currHubPoolLiquidReserves,
          updatedLiquidReserves,
          l1Token,
        });
      }
    });

    // Submit executions at the end since the above double loop runs in parallel and we don't want to submit
    // multiple transactions for the same token.
    if (submitExecution) {
      for (const l1Token of updatedL1Tokens) {
        const tokenSymbol = this.clients.hubPoolClient.getTokenInfoForL1Token(EvmAddress.from(l1Token))?.symbol;
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

  async _updateOldExchangeRates(l1Tokens: EvmAddress[]): Promise<void> {
    const submitExecution = this.config.sendingTransactionsEnabled;
    const { hubPool, chainId } = this.clients.hubPoolClient;
    const seenL1Tokens = new Set<string>();

    await sdk.utils.forEachAsync(l1Tokens, async (l1Token) => {
      if (seenL1Tokens.has(l1Token.toEvmAddress())) {
        return;
      }
      seenL1Tokens.add(l1Token.toEvmAddress());
      const tokenSymbol = this.clients.hubPoolClient.getTokenInfoForL1Token(l1Token)?.symbol;

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
        hubPool.interface.encodeFunctionData("pooledTokens", [l1Token.toEvmAddress()]),
        hubPool.interface.encodeFunctionData("sync", [l1Token.toEvmAddress()]),
        hubPool.interface.encodeFunctionData("pooledTokens", [l1Token.toEvmAddress()]),
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
        l1Token: l1Token.toNative(),
      });
      if (submitExecution) {
        this.clients.multiCallerClient.enqueueTransaction({
          contract: hubPool,
          chainId,
          method: "exchangeRateCurrent",
          args: [l1Token.toEvmAddress()],
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
    for (const client of Object.values(spokePoolClients)) {
      const { chainId } = client;
      if (this.config.executorIgnoreChains.includes(chainId)) {
        continue;
      }
      let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter(
        (rootBundle) => rootBundle.blockNumber >= client.eventSearchConfig.from
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
            hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber || hubPoolClient.latestHeightSearched;

          if (followingBlockNumber === undefined) {
            return false;
          }

          const leaves = hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);

          // Only use this bundle if it had valid leaves returned (meaning it was at least partially executed).
          return leaves.length > 0;
        });

        if (!matchingRootBundle) {
          this.logger.warn({
            at: "Dataworker#executeRelayerRefundLeaves",
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
        const invalidBlockRanges = await this._validateBlockRanges(
          spokePoolClients,
          blockNumberRanges,
          chainIds,
          earliestBlocksInSpokePoolClients
        );
        if (invalidBlockRanges.length > 0) {
          this.logger.warn({
            at: "Dataworker#executeRelayerRefundLeaves",
            message: "Cannot validate bundle with insufficient event data. Set a larger DATAWORKER_FAST_LOOKBACK_COUNT",
            invalidBlockRanges,
            bundleTxn: matchingRootBundle.txnRef,
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
            at: "Dataworker#executeRelayerRefundLeaves",
            message: "Constructed a different root for the block range!",
            chainId,
            rootBundleRelay,
            mainnetRootBundleBlock: matchingRootBundle.blockNumber,
            mainnetRootBundleTxn: matchingRootBundle.txnRef,
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
          rootBundleRelay.rootBundleId
        );
      }
    }
  }

  protected getTokenInfo(l2Token: Address, chainId: number): string {
    try {
      return getTokenInfo(l2Token, chainId).symbol;
    } catch (e) {
      return "UNKNOWN";
    }
  }

  async _executeRelayerRefundLeaves(
    leaves: RelayerRefundLeaf[],
    balanceAllocator: BalanceAllocator,
    client: SpokePoolClient,
    relayerRefundTree: MerkleTree<RelayerRefundLeaf>,
    rootBundleId: number
  ): Promise<void> {
    if (leaves.length === 0) {
      return;
    }
    const chainId = client.chainId;
    const submitExecution = this.config.sendingTransactionsEnabled;

    // Pre-compute msg.value per leaf id to use consistently in allocation and execution
    const msgValuesByLeafId: Map<number, BigNumber | undefined> = new Map();
    await forEachAsync(leaves, async (leaf) => {
      msgValuesByLeafId.set(leaf.leafId, await this._getMsgValueForRelayerRefundLeaf(client, leaf));
    });

    // Filter for leaves where the contract has the funding to send the required tokens.
    const fundedLeaves = (
      await Promise.all(
        leaves.map(async (leaf) => {
          if (leaf.chainId !== chainId) {
            throw new Error("Leaf chainId does not match input chainId");
          }
          const symbol = this.getTokenInfo(leaf.l2TokenAddress, chainId);

          // Exit on duplicate leaf executions if the target network is EVM.
          if (isEVMSpokePoolClient(client)) {
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
            const searchConfig = {
              maxLookBack: client.eventSearchConfig.maxLookBack,
              from: client.latestHeightSearched - client.eventSearchConfig.maxLookBack,
              to: await client.spokePool.provider.getBlockNumber(),
            };
            const duplicateEvents = await sdkUtils.paginatedEventQuery(client.spokePool, eventFilter, searchConfig);
            if (duplicateEvents.length > 0) {
              this.logger.debug({
                at: "Dataworker#executeRelayerRefundLeaves",
                message: `Relayer Refund Leaf #${leaf.leafId} for ${symbol} on chain ${leaf.chainId} already executed`,
                duplicateEvents,
              });
              return undefined;
            }
          }
          const refundSum = leaf.refundAmounts.reduce((acc, curr) => acc.add(curr), BigNumber.from(0));
          const totalSent = refundSum.add(leaf.amountToReturn.gte(0) ? leaf.amountToReturn : BigNumber.from(0));
          const holder = chainIsSvm(leaf.chainId)
            ? SvmAddress.from(await getStatePda(arch.svm.toAddress(client.spokePoolAddress)))
            : client.spokePoolAddress;
          const balanceRequestsToQuery = [
            {
              chainId: leaf.chainId,
              tokens: l2TokensToCountTowardsSpokePoolLeafExecutionCapital(leaf.l2TokenAddress, leaf.chainId),
              holder,
              amount: totalSent,
            },
          ];

          const valueToPassViaPayable = msgValuesByLeafId.get(leaf.leafId);
          // If we have to pass ETH via the payable function, then we need to add a balance request for the signer
          // to ensure that it has enough ETH to send.
          // NOTE: this is ETH required separately from the amount required to send the tokens. Since Solana does not require payments in native tokens for leaf
          // executions, we can also skip this if the spoke pool client is SVM.
          if (isDefined(valueToPassViaPayable) && isEVMSpokePoolClient(client)) {
            const signer = await client.spokePool.signer.getAddress();
            balanceRequestsToQuery.push({
              chainId: leaf.chainId,
              tokens: [toAddressType(ZERO_ADDRESS, leaf.chainId)], // ZERO_ADDRESS is used to represent ETH.
              holder: toAddressType(signer, leaf.chainId), // The signer's address is what will be sending the ETH.
              amount: valueToPassViaPayable,
            });
          }
          // We use the requestBalanceAllocations instead of two separate calls to requestBalanceAllocation because
          // we want the balance to be set in an atomic transaction.
          const success = await balanceAllocator.requestBalanceAllocations(balanceRequestsToQuery);
          if (!success) {
            this.logger.warn({
              at: "Dataworker#_executeRelayerRefundLeaves",
              message: `Not executing relayer refund leaf on chain ${leaf.chainId} due to lack of spoke or msg.sender funds for token ${symbol}`,
              root: relayerRefundTree.getHexRoot(),
              bundle: rootBundleId,
              leafId: leaf.leafId,
              amountToReturn: leaf.amountToReturn,
              totalRefundAmount: leaf.refundAmounts.reduce((acc, curr) => acc.add(curr), BigNumber.from(0)),
              spokeBalance: await this._getSpokeBalanceForL2Tokens(
                balanceAllocator,
                leaf.chainId,
                leaf.l2TokenAddress,
                client.spokePoolAddress
              ),
              requiredEthValue: valueToPassViaPayable,
            });
          } else {
            // If mainnet leaf, then allocate balance to the HubPool since it will be atomically transferred.
            if (leaf.chainId === this.clients.hubPoolClient.chainId && leaf.amountToReturn.gt(0)) {
              balanceAllocator.addUsed(
                leaf.chainId,
                leaf.l2TokenAddress,
                toAddressType(this.clients.hubPoolClient.hubPool.address, leaf.chainId),
                leaf.amountToReturn.mul(-1)
              );
            }
          }

          return success ? leaf : undefined;
        })
      )
    ).filter(isDefined);

    await forEachAsync(fundedLeaves, async (leaf) => {
      const symbol = this.getTokenInfo(leaf.l2TokenAddress, chainId);

      const mrkdwn = `rootBundleId: ${rootBundleId}\nrelayerRefundRoot: ${relayerRefundTree.getHexRoot()}\nLeaf: ${
        leaf.leafId
      }\nchainId: ${chainId}\ntoken: ${symbol}\namount: ${leaf.amountToReturn.toString()}`;
      if (submitExecution) {
        if (isEVMSpokePoolClient(client)) {
          const valueToPassViaPayable = msgValuesByLeafId.get(leaf.leafId);
          const ethersLeaf = {
            ...leaf,
            l2TokenAddress: leaf.l2TokenAddress.toEvmAddress(),
            refundAddresses: leaf.refundAddresses.map((refundAddress) => refundAddress.toEvmAddress()),
          };
          this.clients.multiCallerClient.enqueueTransaction({
            value: valueToPassViaPayable,
            contract: client.spokePool,
            chainId,
            method: "executeRelayerRefundLeaf",
            args: [rootBundleId, ethersLeaf, relayerRefundTree.getHexProof(leaf)],
            message: "Executed RelayerRefundLeaf 🌿!",
            mrkdwn,
            // If mainnet, send through Multicall3 so it can be batched with PoolRebalanceLeaf executions, otherwise
            // SpokePool.multicall() is fine.
            unpermissioned: Number(chainId) === this.clients.hubPoolClient.chainId,
            // If simulating mainnet execution, can fail as it may require funds to be sent from
            // pool rebalance leaf.
            canFailInSimulation: leaf.chainId === this.clients.hubPoolClient.chainId,
          });
        } else if (isSVMSpokePoolClient(client)) {
          const signature = await this._executeRelayerRefundLeafSvm(
            client,
            leaf,
            rootBundleId,
            relayerRefundTree.getHexProof(leaf)
          );
          this.logger.info({
            at: "Dataworker#_executeRelayerRefundLeaves",
            message: mrkdwn,
            signature,
          });
        }
      } else {
        this.logger.debug({ at: "Dataworker#_executeRelayerRefundLeaves", message: mrkdwn });
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
    slowRelayLeaves: SlowFillLeaf[],
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

  _getSpokeBalanceForL2Tokens(
    balanceAllocator: BalanceAllocator,
    chainId: number,
    token: Address,
    holder: Address
  ): Promise<BigNumber> {
    return sdkUtils.reduceAsync(
      l2TokensToCountTowardsSpokePoolLeafExecutionCapital(token, chainId),
      async (acc, token) => acc.add(await balanceAllocator.getBalanceSubUsed(chainId, token, holder)),
      bnZero
    );
  }

  async _getPoolRebalanceRoot(
    spokePoolClients: SpokePoolClientsByChain,
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
      this.rootCache[key] = await _buildPoolRebalanceRoot(
        latestMainnetBlock,
        mainnetBundleEndBlock,
        bundleV3Deposits,
        bundleV3Fills,
        bundleSlowFills,
        unexecutableSlowFills,
        expiredDepositsToRefundV3,
        { ...this.clients, spokePoolClients },
        this.maxL1TokenCountOverride
      );
    }

    this.logger.debug({
      at: "Dataworker#_getPoolRebalanceRoot",
      message: "Constructed new pool rebalance root",
      key,
      root: {
        ...this.rootCache[key],
        leaves: this.rootCache[key].leaves.map((leaf) => {
          return {
            ...leaf,
            l1Tokens: leaf.l1Tokens.map((l1Token) => l1Token.toNative()),
          };
        }),
        tree: this.rootCache[key].tree.getHexRoot(),
      },
    });

    return _.cloneDeep(this.rootCache[key]);
  }

  async _getRequiredEthForOrbitPoolRebalanceLeaf(leaf: PoolRebalanceLeaf): Promise<{
    amount: BigNumber;
    token: EvmAddress;
    holder: EvmAddress;
  }> {
    // TODO: Make this code more dynamic in the future. For now, hard code custom gas token fees.
    let relayMessageFee: BigNumber;
    let token: string;
    let holder: string;
    if (leaf.chainId === CHAIN_IDs.ALEPH_ZERO) {
      // Unlike when handling native ETH, the monitor bot does NOT support sending arbitrary ERC20 tokens to any other
      // EOA, so if we're short a custom gas token like AZERO, then we're going to have to keep sending over token
      // amounts to the DonationBox contract. Therefore, we'll multiply the final amount by 10 to ensure we don't incur
      // a transfer() gas cost on every single pool rebalance leaf execution involving this arbitrum orbit chain.
      const { amountWei, feePayer, feeToken, amountMultipleToFund } =
        ARBITRUM_ORBIT_L1L2_MESSAGE_FEE_DATA[CHAIN_IDs.ALEPH_ZERO];
      relayMessageFee = toBNWei(amountWei).mul(amountMultipleToFund);
      token = feeToken;
      holder = feePayer;
    } else {
      // For now, assume arbitrum message fees are the same for all non-custom gas token chains. This obviously needs
      // to be changed if we add support for an orbit chains where we pay message fees in ETH but they are different
      // parameters than for Arbitrum mainnet.
      const { amountWei, amountMultipleToFund } = ARBITRUM_ORBIT_L1L2_MESSAGE_FEE_DATA[CHAIN_IDs.ARBITRUM];
      relayMessageFee = toBNWei(amountWei).mul(amountMultipleToFund);
      token = ZERO_ADDRESS;
      holder = this.clients.hubPoolClient.hubPool.address;
    }

    // For orbit chains, the bot needs enough ETH to pay for each L1 -> L2 message.
    // The following executions trigger an L1 -> L2 message:
    // 1. The first orbit leaf for a particular set of roots. This means the roots must be sent and is
    //    signified by groupIndex === 0.
    // 2. Any netSendAmount > 0 triggers an L1 -> L2 token send, which costs 0.02 ETH.
    let requiredAmount = leaf.netSendAmounts.reduce(
      (acc, curr) => (curr.gt(0) ? acc.add(relayMessageFee) : acc),
      BigNumber.from(0)
    );

    if (leaf.groupIndex === 0) {
      requiredAmount = requiredAmount.add(relayMessageFee);
    }
    return {
      amount: requiredAmount,
      token: EvmAddress.from(token),
      holder: EvmAddress.from(holder),
    };
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
    assert(
      sdkUtils.chainIsLinea(client.chainId) && isEVMSpokePoolClient(client),
      "This method should only be called on Linea chains!"
    );
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
   * Compute the msg.value to attach when executing a relayer refund leaf on L2.
   * - If amountToReturn == 0 or non-EVM chain: undefined
   * - If OFT is configured on the SpokePool for the token: quote native fee via OFT messenger and return fee*2
   * - Else if Linea: return the pre-fetched Linea L2->L1 message fee
   * - Additionally, enforce OFT-on-Linea mutual exclusion and throw if encountered
   */
  private async _getMsgValueForRelayerRefundLeaf(
    client: SpokePoolClient,
    leaf: RelayerRefundLeaf
  ): Promise<BigNumber | undefined> {
    // We don't support providing SOL value with the executor call, so if spokePool is not evm, or the return amount is 0, exit early
    if (!isEVMSpokePoolClient(client) || !leaf.amountToReturn.gt(0)) {
      return undefined;
    }

    // If the chain is Linea, then we need to allocate ETH in the call to executeRelayerRefundLeaf
    const lineaMsgValuePortion = sdkUtils.chainIsLinea(client.chainId)
      ? await this._getRequiredEthForLineaRelayLeafExecution(client)
      : bnZero;

    // If the SpokePool supports withdrawing tokens to Hub via OFT, estimate msg.value needed to cover OFT fee
    const oftMsgValuePortion = await this._getOftMsgValueForRelayerRefundLeaf(client, leaf);

    // Currently, msg.value behavior in OFT-supporting Spokes is such that they can't hanlde msg.value being used for
    // different cases. If both msg value contributions are above 0, we have a bug. Throw
    if (lineaMsgValuePortion.gt(0) && oftMsgValuePortion.gt(0)) {
      throw new Error("Invalid configuration: OFT messenger set on Linea chain for relayer refund leaf execution");
    }
    const msgValue = lineaMsgValuePortion.add(oftMsgValuePortion);
    return msgValue.gt(0) ? msgValue : undefined;
  }

  private async _getOftMsgValueForRelayerRefundLeaf(
    client: EVMSpokePoolClient,
    leaf: RelayerRefundLeaf
  ): Promise<BigNumber> {
    // ! Todo
    // This mapping is here to distinguish between chains that have `oftMessengers` storage variable and those that
    // require msg.value attached on OFT withdrawals. Currently, Arbitrum_Spoke wouldn't handle the msg.value properly
    // (no refund) so we don't attach that. After Arbitrum_Spoke (and possibly Universal_Spoke) are upgraded to handle
    // msg.value, we can drop this mapping and instead use response from `oftMessengers` call to decide whether a spoke
    // supports withdrawals via OFT
    const CHAINS_SUPPORTING_MSG_VALUE_ON_OFT_WITHDRAWAL = new Set([CHAIN_IDs.POLYGON, CHAIN_IDs.BSC]);

    if (!CHAINS_SUPPORTING_MSG_VALUE_ON_OFT_WITHDRAWAL.has(client.chainId)) {
      return bnZero;
    }

    const associatedOftMessenger = await client.spokePool.oftMessengers(leaf.l2TokenAddress.toNative());
    const oftMessengerIsSet = associatedOftMessenger !== undefined && associatedOftMessenger !== ZERO_ADDRESS;
    if (!oftMessengerIsSet) {
      return bnZero;
    }

    // Construct a message that SpokePool will be using to withdraw via OFT to mainnet. Use `.quoteSend` to estimate
    // required native fee, and send that X 2 as msg.value to cover the transfer fees even in the face of fee chainging
    // slightly. Excess fee will get refunded to executor
    const IOFTContract = new Contract(associatedOftMessenger, IOFT_ABI_FULL, client.spokePool.provider);
    const dstEid = OFT.getEndpointId(this.clients.hubPoolClient.chainId);
    const hubPoolAddr = EvmAddress.from(this.clients.hubPoolClient.hubPool.address);

    const { decimals } = getTokenInfo(leaf.l2TokenAddress, client.chainId);
    const sharedDecimals: number = await IOFTContract.sharedDecimals();

    const roundedAmount = OFT.roundAmountToSend(leaf.amountToReturn, decimals, sharedDecimals);
    const params = OFT.buildSimpleSendParamEvm(hubPoolAddr, dstEid, roundedAmount);
    const fees: OFT.MessagingFeeStruct = await IOFTContract.quoteSend(params, false);
    const nativeFee = BigNumber.from(fees.nativeFee);
    return nativeFee.mul(2);
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
    mainnetBundleStartBlock: number,
    optimistic = false
  ): Promise<number[][]> {
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(mainnetBundleStartBlock);
    return getWidestPossibleExpectedBlockRange(
      // We only want as many block ranges as there are chains enabled at the time of the bundle start block.
      chainIds,
      spokePoolClients,
      getEndBlockBuffers(chainIds, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestHeightSearched,
      // We only want to count enabled chains at the same time that we are loading chain ID indices.
      this.clients.configStoreClient.getEnabledChains(mainnetBundleStartBlock),
      optimistic
    );
  }

  async _validateBlockRanges(
    spokePoolClients: SpokePoolClientsByChain,
    blockRanges: number[][],
    chainIds: number[],
    earliestBlocksInSpokePoolClients: { [chainId: number]: number }
  ): Promise<InvalidBlockRange[]> {
    return await blockRangesAreInvalidForSpokeClients(
      spokePoolClients,
      blockRanges,
      chainIds,
      earliestBlocksInSpokePoolClients
    );
  }

  _prettifyBundleBlockRanges(chainIds: number[], blockRanges: number[][]): Record<number, number[]> {
    return Object.fromEntries(chainIds.map((chainId, i) => [chainId, blockRanges[i]]));
  }

  async _executeRelayerRefundLeafSvm(
    spokePoolClient: SVMSpokePoolClient,
    leaf: RelayerRefundLeaf,
    rootBundleId: number,
    relayerRefundLeafHexProof: string[]
  ): Promise<string> {
    // Parse relevant info from the relayer refund leaf/dataworker.
    const spokePoolProgramId = toKitAddress(spokePoolClient.spokePoolAddress);
    const provider = spokePoolClient.svmEventsClient.getRpc();
    const _l2TokenAddress = leaf.l2TokenAddress;
    assert(
      _l2TokenAddress.isSVM(),
      `Dataworker#executeRelayerRefundLeafSvm: Attempting to execute a relayer refund leaf with token address ${leaf.l2TokenAddress}`
    );
    const l2TokenAddress = toKitAddress(_l2TokenAddress);
    const proof = relayerRefundLeafHexProof.map((hexLeaf) => Uint8Array.from(Buffer.from(hexLeaf.slice(2), "hex")));

    // Derive static accounts.
    const [kitKeypair, eventAuthority, statePda, transferLiabilityPda, _recentBlockhash] = await Promise.all([
      this._getKitKeypair(),
      getEventAuthority(spokePoolProgramId),
      getStatePda(spokePoolProgramId),
      getTransferLiabilityPda(spokePoolProgramId, l2TokenAddress),
      provider.getLatestBlockhash().send(),
    ]);
    const recentBlockhash = _recentBlockhash as { value: LatestBlockhash };
    assert(leaf.l2TokenAddress.isSVM());
    const [rootBundlePda, instructionParamsPda, vault] = await Promise.all([
      getRootBundlePda(spokePoolProgramId, rootBundleId),
      getInstructionParamsPda(spokePoolProgramId, kitKeypair.address),
      getAssociatedTokenAddress(SvmAddress.from(statePda.toString()), leaf.l2TokenAddress),
    ]);
    this.logger.debug({
      at: "Dataworker#executeRelayerRefundLeafSvm",
      message: "Relayer refund leaf accounts",
      leaf: {
        ...leaf,
        l2TokenAddress: leaf.l2TokenAddress.toNative(),
        refundAddresses: leaf.refundAddresses.map((address) => address.toNative()),
      },
      rootBundleId,
      eventAuthority,
      statePda,
      transferLiabilityPda,
      rootBundlePda,
      instructionParamsPda,
      vault,
    });

    // Optionally close the existing instruction params account and add an instruction which loads new data into the instruction params PDA.
    const instructionParamsAccount = await fetchEncodedAccount(provider, instructionParamsPda);
    let closeInstructionParamsIx;
    // If the account exists, define the instruction needed to close the instruction account.
    if (instructionParamsAccount.exists) {
      this.logger.debug({
        at: "Dataworker#executeRelayerRefundLeafSvm",
        message: "Need to close existing instruction params account",
        instructionParamsAccount: instructionParamsAccount.address,
      });
      closeInstructionParamsIx = SvmSpokeClient.getCloseInstructionParamsInstruction({
        signer: kitKeypair,
        instructionParams: instructionParamsPda,
      });
      const closeInstructionParamsTx = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
        (tx) => appendTransactionMessageInstructions([closeInstructionParamsIx], tx)
      );
      const closeSig = await sendAndConfirmSolanaTransaction(closeInstructionParamsTx, kitKeypair, provider);
      this.logger.debug({
        at: "Dataworker#executeRelayerRefundLeafSvm",
        message: "Closed instruction params PDA",
        signature: closeSig,
      });
    }
    // First, add an instruction which initializes a new instruction params PDA for the relayer refund leaf.
    const relayerRefundLeafParamsEncoder = SvmSpokeClient.getExecuteRelayerRefundLeafParamsEncoder();
    const relayerRefundLeafBytes = relayerRefundLeafParamsEncoder.encode({
      rootBundleId,
      relayerRefundLeaf: toSvmRelayerRefundLeaf(leaf),
      proof,
    });
    const initializeInstructionParamsIx = SvmSpokeClient.getInitializeInstructionParamsInstruction({
      signer: kitKeypair,
      instructionParams: instructionParamsPda,
      totalSize: relayerRefundLeafBytes.length,
    });

    const initInstructionParamsTx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
      (tx) => appendTransactionMessageInstructions([initializeInstructionParamsIx], tx)
    );
    let txSignature;
    txSignature = await sendAndConfirmSolanaTransaction(initInstructionParamsTx, kitKeypair, provider);
    this.logger.debug({
      at: "Dataworker#executeRelayerRefundLeafSvm",
      message: "Initialized instruction params account",
      instructionParamsAccount: instructionParamsAccount.address,
      allocatedMemory: relayerRefundLeafBytes.length,
      txSignature,
    });

    // Then add an instruction which populates that initialized PDA with the data of the relayer refund leaf.
    for (let i = 0; i <= relayerRefundLeafBytes.length / INSTRUCTION_PARAMS_MAX_WRITE_SIZE; ++i) {
      const offset = i * INSTRUCTION_PARAMS_MAX_WRITE_SIZE;
      const offsetEnd = Math.min(offset + INSTRUCTION_PARAMS_MAX_WRITE_SIZE, relayerRefundLeafBytes.length) + 1;
      const fragment = relayerRefundLeafBytes.slice(offset, offsetEnd);
      const writeInstructionParamsIx = SvmSpokeClient.getWriteInstructionParamsFragmentInstruction({
        signer: kitKeypair,
        instructionParams: instructionParamsPda,
        offset,
        fragment,
      });
      const writeInstructionParamsTx = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
        (tx) => appendTransactionMessageInstructions([writeInstructionParamsIx], tx)
      );
      txSignature = await sendAndConfirmSolanaTransaction(writeInstructionParamsTx, kitKeypair, provider);
      this.logger.debug({
        at: "Dataworker#executeRelayerRefundLeafSvm",
        message: "Wrote relayer refund leaf data to instruction params account",
        txSignature,
        fragmentLength: fragment.length,
        writeNumber: i,
      });
    }

    // Get the lookup table Pda.
    const recentSlot = await arch.svm.getSlot(provider, "finalized", this.logger);
    const lookupTable = await findAddressLookupTablePda({
      authority: kitKeypair.address,
      recentSlot: Number(recentSlot),
    });
    const lookupTablePda = lookupTable[0];
    const lookupTableIx = getCreateLookupTableInstruction({
      address: lookupTable,
      authority: kitKeypair,
      recentSlot: Number(recentSlot),
    });
    const createLookupTableTx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
      (tx) => appendTransactionMessageInstructions([lookupTableIx], tx)
    );
    txSignature = await sendAndConfirmSolanaTransaction(createLookupTableTx, kitKeypair, provider);
    await waitForNewSolanaBlock(provider, 1);

    this.logger.debug({
      at: "Dataworker#executeRelayerRefundLeafSvm",
      message: "Created relayer refund address lookup table",
      txSignature,
      lookupTable: lookupTablePda,
    });

    // Add logic to deactivate the LUT. The LUT should be deactivated whether or not the relayer refund execution fails.
    const deactivateLut = async () => {
      // We should clean up the LUT now before returning.
      const deactivateLutIx = getDeactivateLookupTableInstruction({
        address: lookupTablePda,
        authority: kitKeypair,
      });
      const deactivateLutTx = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
        (tx) => appendTransactionMessageInstructions([deactivateLutIx], tx)
      );
      const deactivateLutSignature = await sendAndConfirmSolanaTransaction(deactivateLutTx, kitKeypair, provider);
      this.logger.debug({
        at: "Dataworker#executeRelayerRefundLeafSvm",
        message: "Deactivated address lookup table",
        deactivateLutSignature,
      });
    };

    // Wrap all steps beyond creating the address lookup table in a try/catch. This is so that we can still deactivate the ALT in case some transient issue occurs, which should allow us to reclaim the SOL in that account later on.
    let refundLeafSignature;
    try {
      // There are two modes of refunding relayers on SVM:
      // Case 1: All relayers have an initialized ATA, so we call the spoke pool's `executeRelayerRefundLeaf` instruction.
      // Case 2: One or more refund accounts do not have an initialized ATA, so we call `executeRelayerRefundLeafDeferred` and allow the refunds to be
      // pulled from the spoke pool at any later date.
      // We prefer to run case 1; however, if case 1 cannot be completed (since one or more of the `refundAddresses` do not have ATAs for `l2TokenAddress`, then we fallback to case 2.
      const recipientATAs = await mapAsync(leaf.refundAddresses, async (refundAddress) => {
        assert(refundAddress.isSVM());
        const refundATA = await getAssociatedTokenAddress(refundAddress, _l2TokenAddress);
        const encodedAccount = await fetchEncodedAccount(provider, refundATA);
        return { tokenAccount: refundATA, exists: encodedAccount.exists };
      });
      const allRefundAccountsHaveATAs = recipientATAs.every((account) => account.exists);
      // This is case 1. All refundAddresses have a defined ATA.
      if (allRefundAccountsHaveATAs) {
        const executeRelayerRefundLeafIx = SvmSpokeClient.getExecuteRelayerRefundLeafInstruction({
          signer: kitKeypair,
          instructionParams: instructionParamsPda,
          state: statePda,
          rootBundle: rootBundlePda,
          vault,
          mint: l2TokenAddress,
          transferLiability: transferLiabilityPda,
          eventAuthority,
          program: spokePoolProgramId,
        });
        // For the relayer refund case, the remaining accounts to append are the relayer ATAs.
        const refundATAs = recipientATAs.map((ata) => getAccountMeta(ata.tokenAccount, true));
        executeRelayerRefundLeafIx.accounts.push(...refundATAs);
        const lutAddresses = Object.values(executeRelayerRefundLeafIx.accounts).map((account) =>
          address(account.address)
        );
        // Extend the lookup table with both the static and remaining accounts.
        const addressLookupTableDefinitions = getAddressLookupTableInstructions(
          lookupTablePda,
          kitKeypair,
          lutAddresses
        );

        for (const extendLookupTableIx of addressLookupTableDefinitions.instructions) {
          const extendLutTx = pipe(
            createTransactionMessage({ version: 0 }),
            (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
            (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
            (tx) => appendTransactionMessageInstructions([extendLookupTableIx], tx)
          );
          await sendAndConfirmSolanaTransaction(extendLutTx, kitKeypair, provider);
          // @dev Every time we extend an ALT, we need to wait for a new solana block so that the table has
          // sufficient time to "activate." https://solana.com/developers/courses/program-optimization/lookup-tables#6-modify-main-to-use-lookup-tables
          await waitForNewSolanaBlock(provider, 1);
        }

        const executeRelayerRefundLeafTx = pipe(
          createTransactionMessage({ version: 0 }),
          (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
          (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
          (tx) => appendTransactionMessageInstructions([executeRelayerRefundLeafIx], tx),
          (tx) => compressTransactionMessageUsingAddressLookupTables(tx, addressLookupTableDefinitions.lookupTableMap)
        );
        refundLeafSignature = await sendAndConfirmSolanaTransaction(executeRelayerRefundLeafTx, kitKeypair, provider);
      } else {
        // This is case 2. Some refundAddresses do not have ATAs for the l2TokenAddress.
        this.logger.warn({
          at: "Dataworker#executeRelayerRefundLeafSvm",
          message: "Cannot refund all refund address since some ATAs do not exist.",
          recipientAccountsWithNoATAs: recipientATAs
            .filter((account) => !account.exists)
            .map((account) => account.tokenAccount),
        });
        const executeRelayerRefundLeafDeferredIx = SvmSpokeClient.getExecuteRelayerRefundLeafDeferredInstruction({
          signer: kitKeypair,
          instructionParams: instructionParamsPda,
          state: statePda,
          rootBundle: rootBundlePda,
          vault,
          mint: l2TokenAddress,
          transferLiability: transferLiabilityPda,
          eventAuthority,
          program: spokePoolProgramId,
        });
        // For the delayed refund case, the remaining accounts to append are the claim accounts.
        const claimAccounts = await mapAsync(leaf.refundAddresses, async (refundAddress) => {
          const claimAccountPda = await getClaimAccountPda(
            spokePoolProgramId,
            l2TokenAddress,
            toKitAddress(refundAddress)
          );
          const claimAccount = await SvmSpokeClient.fetchMaybeClaimAccount(provider, claimAccountPda);
          return { refundAddress, claimAccount };
        });
        executeRelayerRefundLeafDeferredIx.accounts.push(
          ...claimAccounts.map(({ claimAccount }) => getAccountMeta(claimAccount.address, true))
        );
        const claimAccountsToInitialize = claimAccounts.filter(({ claimAccount }) => !claimAccount.exists);

        // We then need to create all claim accounts which do not already exist. Do this in series to avoid transaction collision issues.
        if (claimAccountsToInitialize.length !== 0) {
          this.logger.debug({
            at: "Dataworker#executeRelayerRefundLeafSvm",
            message: "Need to initialize new claim accounts.",
            claimAccounts: claimAccountsToInitialize.map(({ claimAccount }) => claimAccount.address),
          });
          for (const claimAccount of claimAccountsToInitialize) {
            const initializeClaimAccountIx = SvmSpokeClient.getInitializeClaimAccountInstruction({
              signer: kitKeypair,
              mint: l2TokenAddress,
              refundAddress: toKitAddress(claimAccount.refundAddress),
              claimAccount: claimAccount.claimAccount.address,
            });
            const initializeClaimAccountTx = pipe(
              createTransactionMessage({ version: 0 }),
              (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
              (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
              (tx) => appendTransactionMessageInstructions([initializeClaimAccountIx], tx)
            );
            txSignature = await sendAndConfirmSolanaTransaction(initializeClaimAccountTx, kitKeypair, provider);
            this.logger.debug({
              at: "Dataworker#executeRelayerRefundLeafSvm",
              message: "Initialized claim account",
              claimAccount: claimAccount.claimAccount.address,
              refundAddress: claimAccount.refundAddress,
              txSignature,
            });
          }
        }

        // Then extend the ALT with all static and remaining accounts.
        const lutAddresses = Object.values(executeRelayerRefundLeafDeferredIx.accounts).map((account) =>
          address(account.address)
        );
        const addressLookupTableDefinitions = getAddressLookupTableInstructions(
          lookupTablePda,
          kitKeypair,
          lutAddresses
        );

        for (const extendLookupTableIx of addressLookupTableDefinitions.instructions) {
          const extendLutTx = pipe(
            createTransactionMessage({ version: 0 }),
            (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
            (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
            (tx) => appendTransactionMessageInstructions([extendLookupTableIx], tx)
          );
          await sendAndConfirmSolanaTransaction(extendLutTx, kitKeypair, provider);
          // @dev Every time we extend an ALT, we need to wait for a new solana block so that the table has
          // sufficient time to "activate." https://solana.com/developers/courses/program-optimization/lookup-tables#6-modify-main-to-use-lookup-tables
          await waitForNewSolanaBlock(provider, 1);
        }

        const executeRelayerRefundLeafDeferredTx = pipe(
          createTransactionMessage({ version: 0 }),
          (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
          (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
          (tx) => appendTransactionMessageInstructions([executeRelayerRefundLeafDeferredIx], tx),
          (tx) => compressTransactionMessageUsingAddressLookupTables(tx, addressLookupTableDefinitions.lookupTableMap)
        );
        refundLeafSignature = await sendAndConfirmSolanaTransaction(
          executeRelayerRefundLeafDeferredTx,
          kitKeypair,
          provider
        );
        const claimRelayerRefund = async (
          refundAddress: KitAddress<string>,
          claimAccount: KitAddress<string>,
          initializer: KitAddress<string>,
          tokenAccount: KitAddress<string>
        ): Promise<string> => {
          const claimRelayerRefundIx = SvmSpokeClient.getClaimRelayerRefundInstruction({
            signer: kitKeypair,
            initializer,
            state: statePda,
            vault,
            mint: l2TokenAddress,
            refundAddress,
            tokenAccount,
            claimAccount,
            eventAuthority,
            program: spokePoolProgramId,
          });
          this.logger.debug({
            at: "Dataworker#executeRelayerRefundLeafSvm",
            message: "Claim relayer refund accounts",
            tokenAccount,
            claimAccount,
            refundAddress,
          });
          const claimRelayerRefundTx = pipe(await createDefaultTransaction(provider, kitKeypair), (tx) =>
            appendTransactionMessageInstructions([claimRelayerRefundIx], tx)
          );
          return await sendAndConfirmSolanaTransaction(claimRelayerRefundTx, kitKeypair, provider);
        };
        // Zip the claimAccounts with the recipient ATA and then claim all refunds corresponding to refund accounts with ATAs.
        const recipientTokenAccounts = claimAccounts.map((claimAccount, idx) => {
          return { claimAccount, recipientATA: recipientATAs[idx] };
        });
        const claimedRefunds = [];
        for (const accountData of recipientTokenAccounts) {
          // If the recipient ATA does not exist, then we should not attempt to close the claim account.
          if (!accountData.recipientATA.exists) {
            continue;
          }
          // If the claim account exists, then initializer will be defined https://github.com/anza-xyz/kit/blob/491c96ed8ccda40d13b30deaf03ad762de58e0d5/packages/accounts/src/maybe-account.ts#L90.
          // Otherwise, this means that we created the claim account earlier in this function, so the kit keypair is the initializer.
          const initializer = accountData.claimAccount.claimAccount.exists
            ? accountData.claimAccount.claimAccount.data!.initializer
            : kitKeypair.address;
          const claimRefundSignature = await claimRelayerRefund(
            toKitAddress(accountData.claimAccount.refundAddress),
            accountData.claimAccount.claimAccount.address,
            initializer,
            accountData.recipientATA.tokenAccount
          );
          claimedRefunds.push([accountData.claimAccount.refundAddress.toNative(), claimRefundSignature]);
        }
        this.logger.debug({
          at: "Dataworker#executeRelayerRefundLeafSvm",
          message: "Claimed relayer refunds for all addresses with ATAs",
          claimSignatures: Object.fromEntries(claimedRefunds),
        });
      }
    } catch (e) {
      this.logger.error({
        at: "Dataworker#executeRelayerRefundLeafSvm",
        message: "Something failed during the relayer refund leaf execution stage",
        error: e,
      });
      await deactivateLut();
      throw e;
    }
    // The refund was successful, so return the signature.
    await deactivateLut();

    return refundLeafSignature;
  }

  async _executeSlowFillLeafSvm(
    spokePoolClient: SVMSpokePoolClient,
    leaf: SlowFillLeaf,
    rootBundleId: number,
    slowFillHexProof: string[]
  ): Promise<string> {
    // Parse relevant info from the slow fill leaf/dataworker.
    const provider = spokePoolClient.svmEventsClient.getRpc();
    const spokePoolProgramId = toKitAddress(spokePoolClient.spokePoolAddress);
    const l2TokenAddress = toKitAddress(leaf.relayData.outputToken);
    const recipient = toKitAddress(leaf.relayData.recipient);
    const proof = slowFillHexProof.map((hexLeaf) => Uint8Array.from(Buffer.from(hexLeaf.slice(2), "hex")));

    // Gather the PDAs required to execute the slow fill leaf.
    const [kitKeypair, eventAuthority, statePda, fillStatusPda, _recentBlockhash] = await Promise.all([
      this._getKitKeypair(),
      getEventAuthority(spokePoolProgramId),
      getStatePda(spokePoolProgramId),
      getFillStatusPda(spokePoolProgramId, leaf.relayData, leaf.chainId),
      provider.getLatestBlockhash().send(),
    ]);
    const recentBlockhash = _recentBlockhash as { value: LatestBlockhash };
    assert(leaf.relayData.outputToken.isSVM());
    const [rootBundlePda, recipientTokenAccount, vault] = await Promise.all([
      getRootBundlePda(spokePoolProgramId, rootBundleId),
      getAssociatedTokenAddress(SvmAddress.from(recipient.toString()), leaf.relayData.outputToken),
      getAssociatedTokenAddress(SvmAddress.from(statePda.toString()), leaf.relayData.outputToken),
    ]);
    this.logger.debug({
      at: "Dataworker#executeSlowFillLeafSvm",
      message: "Slow fill leaf accounts",
      eventAuthority,
      statePda,
      fillStatusPda,
      rootBundlePda,
      recipientTokenAccount,
      vault,
    });

    // Get the slow fill information.
    const messageHash = getMessageHash(leaf.relayData.message);
    const relayDataHash = getRelayDataHash({ ...leaf.relayData, messageHash }, leaf.chainId);

    // Construct the slow fill instruction.
    const executeSlowFillIx = SvmSpokeClient.getExecuteSlowRelayLeafInstruction({
      signer: kitKeypair,
      state: statePda,
      rootBundle: rootBundlePda,
      fillStatus: fillStatusPda,
      mint: l2TokenAddress,
      recipientTokenAccount,
      vault,
      eventAuthority,
      program: spokePoolProgramId,
      relayHash: Buffer.from(relayDataHash.slice(2), "hex"),
      slowFillLeaf: some(toSvmSlowFillLeaf(leaf)),
      rootBundleId: some(rootBundleId),
      proof: some(proof),
    });

    // Check whether the recipient on Solana has an ATA for the output token. If they do not, then create one and include that in the instruction set.
    let recipientCreateTokenAccountInstruction;
    const associatedTokenAccountExists = (await fetchEncodedAccount(provider, recipientTokenAccount)).exists;
    if (!associatedTokenAccountExists) {
      const mint = arch.svm.toAddress(leaf.relayData.outputToken);
      const mintInfo = await arch.svm.getMintInfo(spokePoolClient.svmEventsClient.getRpc(), mint);
      const programAddress = mintInfo.programAddress;
      recipientCreateTokenAccountInstruction = getCreateAssociatedTokenIdempotentInstruction({
        payer: kitKeypair,
        owner: statePda,
        mint: l2TokenAddress,
        ata: recipientTokenAccount,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
        tokenProgram: programAddress,
      });
    }

    // Build the slow fill transaction. If there are instructions to create a new token account, then add those instructions to the slow fill transaction. Otherwise,
    // only include the slow fill instruction.
    const executeSlowFillTx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(kitKeypair.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
      (tx) =>
        isDefined(recipientCreateTokenAccountInstruction)
          ? appendTransactionMessageInstructions([recipientCreateTokenAccountInstruction], tx)
          : tx,
      (tx) => appendTransactionMessageInstructions([executeSlowFillIx], tx)
    );
    return sendAndConfirmSolanaTransaction(executeSlowFillTx, kitKeypair, provider);
  }

  async _getKitKeypair(): Promise<KeyPairSigner> {
    return getKitKeypairFromEvmSigner(this.clients.hubPoolClient.hubPool.signer);
  }
}
