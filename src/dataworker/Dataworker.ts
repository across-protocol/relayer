import { winston, EMPTY_MERKLE_ROOT, sortEventsDescending, BigNumber, getRefund } from "../utils";
import {
  UnfilledDeposit,
  Deposit,
  DepositWithBlock,
  PendingRootBundle,
  UnfilledDepositsForOriginChain,
  TreeData,
  RunningBalances,
  FillWithBlock,
  PoolRebalanceLeaf,
  RelayerRefundLeaf,
  BigNumberForToken,
  FillsToRefund,
  RelayData,
} from "../interfaces";
import { DataworkerClients, spokePoolClientsToProviders } from "./DataworkerClientHelper";
import { SpokePoolClient } from "../clients";
import * as PoolRebalanceUtils from "./PoolRebalanceUtils";
import {
  assignValidFillToFillsToRefund,
  getFillsInRange,
  getRefundInformationFromFill,
  updateTotalRefundAmount,
  updateTotalRealizedLpFeePct,
} from "./FillUtils";
import {
  getBlockRangeForChain,
  getEndBlockBuffers,
  prettyPrintSpokePoolEvents,
  _buildPoolRebalanceRoot,
  _buildRelayerRefundRoot,
  _buildSlowRelayRoot,
} from "./DataworkerUtils";
import {
  flattenAndFilterUnfilledDepositsByOriginChain,
  updateUnfilledDepositsWithMatchedDeposit,
  getUniqueDepositsInRange,
} from "./DepositUtils";
import { constructSpokePoolClientsForBlockAndUpdate } from "../common/ClientHelper";
import { BalanceAllocator } from "../clients/BalanceAllocator";

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  private loadDataCache: {
    [key: string]: {
      unfilledDeposits: UnfilledDeposit[];
      fillsToRefund: FillsToRefund;
      allValidFills: FillWithBlock[];
      deposits: DepositWithBlock[];
    };
  } = {};

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: DataworkerClients,
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly maxRefundCountOverride: number = undefined,
    readonly maxL1TokenCountOverride: number = undefined,
    readonly tokenTransferThreshold: BigNumberForToken = {},
    readonly blockRangeEndBlockBuffer: { [chainId: number]: number } = {},
    readonly spokeRootsLookbackCount = 0
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
    this.loadDataCache = {};
  }

  // Common data re-formatting logic shared across all data worker public functions.
  // User must pass in spoke pool to search event data against. This allows the user to refund relays and fill deposits
  // on deprecated spoke pools.
  _loadData(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    logData = true
  ): {
    unfilledDeposits: UnfilledDeposit[];
    fillsToRefund: FillsToRefund;
    allValidFills: FillWithBlock[];
    deposits: DepositWithBlock[];
  } {
    const key = JSON.stringify(blockRangesForChains);

    if (this.loadDataCache[key]) {
      return this.loadDataCache[key];
    }

    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    if (!this.clients.configStoreClient.isUpdated) throw new Error(`ConfigStoreClient not updated`);
    this.chainIdListForBundleEvaluationBlockNumbers.forEach((chainId) => {
      if (!spokePoolClients[chainId]) throw new Error(`Missing spoke pool client for chain ${chainId}`);
    });
    if (blockRangesForChains.length !== this.chainIdListForBundleEvaluationBlockNumbers.length)
      throw new Error(
        `Unexpected block range list length of ${blockRangesForChains.length}, should be ${this.chainIdListForBundleEvaluationBlockNumbers.length}`
      );

    const unfilledDepositsForOriginChain: UnfilledDepositsForOriginChain = {};
    const fillsToRefund: FillsToRefund = {};
    const allRelayerRefunds: any[] = [];
    const deposits: DepositWithBlock[] = [];
    const allValidFills: FillWithBlock[] = [];
    const allInvalidFills: FillWithBlock[] = [];

    const allChainIds = Object.keys(this.clients.spokePoolSigners);

    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];
      if (!originClient.isUpdated) throw new Error(`origin SpokePoolClient on chain ${originChainId} not updated`);

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) continue;

        const destinationClient = spokePoolClients[destinationChainId];
        if (!destinationClient.isUpdated)
          throw new Error(`destination SpokePoolClient with chain ID ${destinationChainId} not updated`);

        // Store all deposits in range, for use in constructing a pool rebalance root. Save deposits with
        // their quote time block numbers so we can pull the L1 token counterparts for the quote timestamp.
        // We can safely filter `deposits` by the bundle block range because its only used to decrement running
        // balances in the pool rebalance root. This array is NOT used when matching fills with deposits. For that,
        // we use the wider event search config of the origin client.
        deposits.push(
          ...getUniqueDepositsInRange(
            blockRangesForChains,
            Number(originChainId),
            Number(destinationChainId),
            this.chainIdListForBundleEvaluationBlockNumbers,
            originClient,
            deposits
          )
        );

        const blockRangeForChain = getBlockRangeForChain(
          blockRangesForChains,
          Number(destinationChainId),
          this.chainIdListForBundleEvaluationBlockNumbers
        );

        // Find all valid fills matching a deposit on the origin chain and sent on the destination chain.
        destinationClient.getFillsWithBlockForOriginChain(Number(originChainId)).forEach((fillWithBlock) => {
          // If fill matches with a deposit, then its a valid fill.
          const matchedDeposit: Deposit = originClient.getDepositForFill(fillWithBlock);
          if (matchedDeposit) {
            // Fill was validated. Save it under all validated fills list with the block number so we can sort it by
            // time. Note that its important we don't skip fills outside of the block range at this step because
            // we use allValidFills to find the first fill in the entire history associated with a fill in the block
            // range, in order to determine if we already sent a slow fill for it.
            allValidFills.push(fillWithBlock);

            // If fill is outside block range, we can skip it now since we're not going to add a refund for it.
            if (fillWithBlock.blockNumber > blockRangeForChain[1] || fillWithBlock.blockNumber < blockRangeForChain[0])
              return;

            // Now create a copy of fill with block data removed, and use its data to update the fills to refund obj.
            const { blockNumber, transactionIndex, logIndex, ...fill } = fillWithBlock;
            const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
              fill,
              this.clients.hubPoolClient,
              blockRangesForChains,
              this.chainIdListForBundleEvaluationBlockNumbers
            );

            // Fills to refund includes both slow and non-slow fills and they both should increase the
            // total realized LP fee %.
            assignValidFillToFillsToRefund(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);
            allRelayerRefunds.push({ repaymentToken, repaymentChain: chainToSendRefundTo });
            updateTotalRealizedLpFeePct(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);

            // Save deposit as one that is eligible for a slow fill, since there is a fill
            // for the deposit in this epoch. We save whether this fill is the first fill for the deposit, because
            // if a deposit has its first fill in this block range, then we can send a slow fill payment to complete
            // the deposit. If other fills end up completing this deposit, then we'll remove it from the unfilled
            // deposits later.
            updateUnfilledDepositsWithMatchedDeposit(fill, matchedDeposit, unfilledDepositsForOriginChain);

            // Update total refund counter for convenience when constructing relayer refund leaves
            updateTotalRefundAmount(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);
          } else {
            // Note: If the fill's origin chain is set incorrectly (e.g. equal to the destination chain, or
            // set to some unexpected chain), then it won't be added to `allInvalidFills` because we wouldn't
            // have been able to grab it from the destinationClient.getFillsWithBlockForOriginChain call.
            allInvalidFills.push(fillWithBlock);
          }
        });
      }
    }

    // For each deposit with a matched fill, figure out the unfilled amount that we need to slow relay. We will filter
    // out any deposits that are fully filled.
    const unfilledDeposits = flattenAndFilterUnfilledDepositsByOriginChain(unfilledDepositsForOriginChain);

    const spokeEventsReadable = prettyPrintSpokePoolEvents(
      blockRangesForChains,
      this.chainIdListForBundleEvaluationBlockNumbers,
      deposits,
      allValidFills,
      allRelayerRefunds,
      unfilledDeposits,
      allInvalidFills
    );
    if (logData) {
      const mainnetRange = getBlockRangeForChain(
        blockRangesForChains,
        1,
        this.chainIdListForBundleEvaluationBlockNumbers
      );
      this.logger.debug({
        at: "Dataworker",
        message: `Finished loading spoke pool data for the equivalent of mainnet range: [${mainnetRange[0]}, ${mainnetRange[1]}]`,
        blockRangesForChains,
        ...spokeEventsReadable,
      });
    }

    if (Object.keys(spokeEventsReadable.allInvalidFillsInRangeByDestinationChain).length > 0)
      this.logger.debug({
        at: "Dataworker",
        message: `Finished loading spoke pool data and found some invalid fills in range`,
        blockRangesForChains,
        allInvalidFillsInRangeByDestinationChain: spokeEventsReadable.allInvalidFillsInRangeByDestinationChain,
      });

    this.loadDataCache[key] = { fillsToRefund, deposits, unfilledDeposits, allValidFills };
    return this.loadDataCache[key];
  }

  buildSlowRelayRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    const { unfilledDeposits } = this._loadData(blockRangesForChains, spokePoolClients);
    return _buildSlowRelayRoot(unfilledDeposits);
  }

  buildRelayerRefundRoot(
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

    const { fillsToRefund } = this._loadData(blockRangesForChains, spokePoolClients);
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

  buildPoolRebalanceRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = this._loadData(
      blockRangesForChains,
      spokePoolClients
    );

    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForChains,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesForChains,
      this.chainIdListForBundleEvaluationBlockNumbers
    );

    return _buildPoolRebalanceRoot(
      endBlockForMainnet,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      this.clients,
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.maxL1TokenCountOverride,
      this.tokenTransferThreshold
    );
  }

  async proposeRootBundle(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    usdThresholdToSubmitNewBundle?: BigNumber,
    submitProposals: boolean = true
  ) {
    // TODO: Handle the case where we can't get event data or even blockchain data from any chain. This will require
    // some changes to override the bundle block range here, and _loadData to skip chains with zero block ranges.
    // For now, we assume that if one blockchain fails to return data, then this entire function will fail. This is a
    // safe strategy but could lead to new roots failing to be proposed until ALL networks are healthy.

    // 0. Check if a bundle is pending.
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    if (this.clients.hubPoolClient.hasPendingProposal()) {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "Has pending proposal, cannot propose",
      });
      return;
    }

    // 1. Construct a list of ending block ranges for each chain that we want to include
    // relay events for. The ending block numbers for these ranges will be added to a "bundleEvaluationBlockNumbers"
    // list, and the order of chain ID's is hardcoded in the ConfigStore client.
    const blockRangesForProposal = await PoolRebalanceUtils.getWidestPossibleExpectedBlockRange(
      this.chainIdListForBundleEvaluationBlockNumbers,
      getEndBlockBuffers(this.chainIdListForBundleEvaluationBlockNumbers, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockNumber
    );

    // 2. Construct spoke pool clients using spoke pools deployed at end of block range.
    // We do make an assumption that the spoke pool contract was not changed during the block range. By using the
    // spoke pool at this block instead of assuming its the currently deployed one, we can pay refunds for deposits
    // on deprecated spoke pools.
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForProposal,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    // 3. Create roots
    const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = this._loadData(
      blockRangesForProposal,
      spokePoolClients
    );
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesForProposal,
      this.chainIdListForBundleEvaluationBlockNumbers
    );
    this.logger.debug({ at: "Dataworker", message: `Building pool rebalance root`, blockRangesForProposal });
    const poolRebalanceRoot = _buildPoolRebalanceRoot(
      endBlockForMainnet,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      this.clients,
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.maxL1TokenCountOverride,
      this.tokenTransferThreshold
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
          message: `Root bundle USD volume does not exceed threshold, exiting early 🟡`,
          usdThresholdToSubmitNewBundle,
          totalUsdRefund,
          leaves: poolRebalanceRoot.leaves,
        });
        return;
      } else
        this.logger.debug({
          at: "Dataworker",
          message: `Root bundle USD volume exceeds threshold! 💚`,
          usdThresholdToSubmitNewBundle,
          totalUsdRefund,
        });
    }

    this.logger.debug({ at: "Dataworker", message: `Building relayer refund root`, blockRangesForProposal });
    const relayerRefundRoot = _buildRelayerRefundRoot(
      endBlockForMainnet,
      fillsToRefund,
      poolRebalanceRoot.leaves,
      poolRebalanceRoot.runningBalances,
      this.clients,
      this.maxRefundCountOverride
        ? this.maxRefundCountOverride
        : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet),
      this.tokenTransferThreshold
    );
    PoolRebalanceUtils.prettyPrintLeaves(
      this.logger,
      relayerRefundRoot.tree,
      relayerRefundRoot.leaves,
      "Relayer refund"
    );
    this.logger.debug({ at: "Dataworker", message: `Building slow relay root`, blockRangesForProposal });
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
    spokePoolClients?: { [chainId: number]: SpokePoolClient },
    submitDisputes: boolean = true
  ) {
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;

    // Exit early if a bundle is not pending.
    if (this.clients.hubPoolClient.hasPendingProposal() === false) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "No pending proposal, nothing to validate",
      });
      return;
    }

    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundle();
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
      getEndBlockBuffers(this.chainIdListForBundleEvaluationBlockNumbers, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockNumber
    );
    const { valid, reason } = await this.validateRootBundle(
      hubPoolChainId,
      widestPossibleExpectedBlockRange,
      pendingRootBundle,
      spokePoolClients
    );
    if (!valid) {
      this.logger.error({
        at: "Dataworker",
        message: "Submitting dispute 🤏🏼",
        mrkdwn: reason,
      });
      if (submitDisputes) this._submitDisputeWithMrkdwn(hubPoolChainId, reason);
    }
  }

  async validateRootBundle(
    hubPoolChainId: number,
    widestPossibleExpectedBlockRange: number[][],
    rootBundle: PendingRootBundle,
    spokePoolClients?: { [chainId: number]: SpokePoolClient }
  ): Promise<{
    valid: boolean;
    reason?: string;
    expectedTrees?: {
      poolRebalanceTree: TreeData<PoolRebalanceLeaf>;
      relayerRefundTree: TreeData<RelayerRefundLeaf>;
      slowRelayTree: TreeData<RelayData>;
    };
  }> {
    // If pool rebalance root is empty, always dispute. There should never be a bundle with an empty rebalance root.
    if (rootBundle.poolRebalanceRoot === EMPTY_MERKLE_ROOT) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Empty pool rebalance root, submitting dispute",
        rootBundle,
      });
      return {
        valid: false,
        reason: `Disputed pending root bundle with empty pool rebalance root`,
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
        reason: `Disputed pending root bundle with incorrect bundle block range length`,
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
          message: "A bundle end block is > latest block but within buffer, skipping",
          expectedEndBlocks: widestPossibleExpectedBlockRange.map((range) => range[1]),
          pendingEndBlocks: rootBundle.bundleEvaluationBlockNumbers,
          endBlockBuffers,
        });
      }
      return {
        valid: true,
      };
    }

    // The block range that we'll use to construct roots will be the end block specified in the pending root bundle,
    // and the block right after the last valid root bundle proposal's end block. If the proposer didn't use the same
    // start block, then they might have missed events and the roots will be different.
    const blockRangesImpliedByBundleEndBlocks = widestPossibleExpectedBlockRange.map((blockRange, index) => [
      blockRange[0],
      rootBundle.bundleEvaluationBlockNumbers[index],
    ]);

    this.logger.debug({
      at: "Dataworker#validate",
      message: "Implied bundle ranges are valid",
      blockRangesImpliedByBundleEndBlocks,
      chainIdListForBundleEvaluationBlockNumbers: this.chainIdListForBundleEvaluationBlockNumbers,
    });

    // Construct spoke pool clients using spoke pools deployed at end of block range.
    // We do make an assumption that the spoke pool contract was not changed during the block range. By using the
    // spoke pool at this block instead of assuming its the currently deployed one, we can pay refunds for deposits
    // on deprecated spoke pools.
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesImpliedByBundleEndBlocks,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];
    if (spokePoolClients === undefined)
      spokePoolClients = await constructSpokePoolClientsForBlockAndUpdate(
        this.chainIdListForBundleEvaluationBlockNumbers,
        this.clients,
        this.logger,
        endBlockForMainnet
      );

    // Compare roots with expected. The roots will be different if the block range start blocks were different
    // than the ones we constructed above when the original proposer submitted their proposal. The roots will also
    // be different if the events on any of the contracts were different.
    const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = this._loadData(
      blockRangesImpliedByBundleEndBlocks,
      spokePoolClients
    );
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesImpliedByBundleEndBlocks,
      this.chainIdListForBundleEvaluationBlockNumbers
    );
    const expectedPoolRebalanceRoot = _buildPoolRebalanceRoot(
      endBlockForMainnet,
      fillsToRefund,
      deposits,
      allValidFills,
      allValidFillsInRange,
      unfilledDeposits,
      this.clients,
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.maxL1TokenCountOverride,
      this.tokenTransferThreshold
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
      };
    }

    return {
      valid: false,
      reason:
        PoolRebalanceUtils.generateMarkdownForDispute(rootBundle) +
        `\n` +
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
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients))
  ) {
    this.logger.debug({
      at: "Dataworker#executeSlowRelayLeaves",
      message: "Executing slow relay leaves",
    });

    await Promise.all(
      Object.entries(spokePoolClients).map(async ([chainId, client]) => {
        let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter(
          (rootBundle) => rootBundle.slowRelayRoot !== EMPTY_MERKLE_ROOT
        );

        // Only grab the most recent n roots that have been sent if configured to do so.
        if (this.spokeRootsLookbackCount !== 0)
          rootBundleRelays = rootBundleRelays.slice(0, this.spokeRootsLookbackCount);

        this.logger.debug({
          at: "Dataworker#executeSlowRelayLeaves",
          message: `Evaluating ${rootBundleRelays.length} historical non-empty slow roots relayed to chain ${chainId}`,
        });

        const sortedFills = sortEventsDescending(client.fillsWithBlockNumbers);

        const slowFillsForChain = client.getFills().filter((fill) => fill.isSlowRelay);
        for (const rootBundleRelay of rootBundleRelays) {
          const matchingRootBundle = this.clients.hubPoolClient.getProposedRootBundles().find((bundle) => {
            if (bundle.slowRelayRoot !== rootBundleRelay.slowRelayRoot) return false;

            const followingBlockNumber =
              this.clients.hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber ||
              this.clients.hubPoolClient.latestBlockNumber;

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

          const { unfilledDeposits } = this._loadData(
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
              mainnetRootBundleBlock: matchingRootBundle.blockNumber,
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
          if (unexecutedLeaves.length === 0) return;

          const leavesWithLatestFills = unexecutedLeaves.map((leaf) => {
            const fill = sortedFills.find((fill) => {
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
                  leaf.destinationToken,
                  client.spokePool.address,
                  amountRequired
                );

                if (!success) {
                  this.logger.debug({
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
          ).filter((element) => element !== undefined);

          fundedLeaves.forEach((leaf) => {
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
              mrkdwn: `rootBundleId: ${rootBundleRelay.rootBundleId}\nslowRelayRoot: ${
                rootBundleRelay.slowRelayRoot
              }\nOrigin chain: ${leaf.originChainId}\nDestination chain:${leaf.destinationChainId}\nDeposit Id: ${
                leaf.depositId
              }\namount: ${leaf.amount.toString()}`, // Just a placeholder
            });
          });
        }
      })
    );
  }

  async executePoolRebalanceLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients))
  ) {
    this.logger.debug({
      at: "Dataworker#executePoolRebalanceLeaves",
      message: "Executing pool rebalance leaves",
    });

    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;

    // Exit early if a bundle is not pending.
    if (!this.clients.hubPoolClient.hasPendingProposal()) {
      this.logger.debug({
        at: "Dataworker#executePoolRebalanceLeaves",
        message: "No pending proposal, nothing to execute",
      });
      return;
    }

    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundle();
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
      getEndBlockBuffers(this.chainIdListForBundleEvaluationBlockNumbers, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockNumber
    );
    const { valid, reason, expectedTrees } = await this.validateRootBundle(
      hubPoolChainId,
      widestPossibleExpectedBlockRange,
      pendingRootBundle,
      spokePoolClients
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
      this.clients.hubPoolClient.getMostRecentProposedRootBundle(this.clients.hubPoolClient.latestBlockNumber),
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
            token: leaf.l1Tokens[i],
            holder: this.clients.hubPoolClient.hubPool.address,
            chainId: hubPoolChainId,
          }));

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
    ).filter((element) => element !== undefined);

    fundedLeaves.forEach((leaf) => {
      const proof = expectedTrees.poolRebalanceTree.tree.getHexProof(leaf);

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
        mrkdwn: `Root hash: ${expectedTrees.poolRebalanceTree.tree.getHexRoot()}\nLeaf: ${leaf.leafId}\nChain: ${
          leaf.chainId
        }`, // Just a placeholder
      });
    });
  }

  async executeRelayerRefundLeaves(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    balanceAllocator: BalanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients))
  ) {
    this.logger.debug({
      at: "Dataworker#executeRelayerRefundLeaves",
      message: "Executing relayer refund leaves",
    });

    await Promise.all(
      Object.entries(spokePoolClients).map(async ([chainId, client]) => {
        let rootBundleRelays = sortEventsDescending(client.getRootBundleRelays()).filter(
          (rootBundle) => rootBundle.relayerRefundRoot !== EMPTY_MERKLE_ROOT
        );

        // Only grab the most recent n roots that have been sent if configured to do so.
        if (this.spokeRootsLookbackCount !== 0)
          rootBundleRelays = rootBundleRelays.slice(0, this.spokeRootsLookbackCount);

        this.logger.debug({
          at: "Dataworker#executeRelayerRefundLeaves",
          message: `Evaluating ${rootBundleRelays.length} historical non-empty relayer refund root bundles on chain ${chainId}`,
        });

        const executedLeavesForChain = client.getRelayerRefundExecutions();
        for (const rootBundleRelay of rootBundleRelays) {
          const matchingRootBundle = this.clients.hubPoolClient.getProposedRootBundles().find((bundle) => {
            if (bundle.relayerRefundRoot !== rootBundleRelay.relayerRefundRoot) return false;
            const followingBlockNumber =
              this.clients.hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber ||
              this.clients.hubPoolClient.latestBlockNumber;

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

          const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = this._loadData(
            blockNumberRanges,
            spokePoolClients,
            false // Don't log this function's result since we're calling it once per chain per root bundle
          );

          const endBlockForMainnet = getBlockRangeForChain(
            blockNumberRanges,
            1,
            this.chainIdListForBundleEvaluationBlockNumbers
          )[1];
          const allValidFillsInRange = getFillsInRange(
            allValidFills,
            blockNumberRanges,
            this.chainIdListForBundleEvaluationBlockNumbers
          );
          const expectedPoolRebalanceRoot = _buildPoolRebalanceRoot(
            endBlockForMainnet,
            fillsToRefund,
            deposits,
            allValidFills,
            allValidFillsInRange,
            unfilledDeposits,
            this.clients,
            this.chainIdListForBundleEvaluationBlockNumbers,
            this.maxL1TokenCountOverride,
            this.tokenTransferThreshold
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
              mainnetRootBundleBlock: matchingRootBundle.blockNumber,
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
          if (unexecutedLeaves.length === 0) return;

          // Filter for leaves where the contract has the funding to send the required tokens.
          const fundedLeaves = (
            await Promise.all(
              unexecutedLeaves.map(async (leaf) => {
                const refundSum = leaf.refundAmounts.reduce((acc, curr) => acc.add(curr), BigNumber.from(0));
                const totalSent = refundSum.add(leaf.amountToReturn.gte(0) ? leaf.amountToReturn : BigNumber.from(0));
                const success = await balanceAllocator.requestBalanceAllocation(
                  leaf.chainId,
                  leaf.l2TokenAddress,
                  client.spokePool.address,
                  totalSent
                );

                if (!success) {
                  this.logger.debug({
                    at: "Dataworker#executeRelayerRefundLeaves",
                    message: "Not executing relayer refund leaf on SpokePool due to lack of funds.",
                    root: rootBundleRelay.relayerRefundRoot,
                    bundle: rootBundleRelay.rootBundleId,
                    leafId: leaf.leafId,
                    token: leaf.l2TokenAddress,
                    chainId: leaf.chainId,
                    amountToReturn: leaf.amountToReturn,
                    refunds: leaf.refundAmounts,
                  });
                }

                return success ? leaf : undefined;
              })
            )
          ).filter((element) => element !== undefined);

          fundedLeaves.forEach((leaf) => {
            this.clients.multiCallerClient.enqueueTransaction({
              contract: client.spokePool,
              chainId: Number(chainId),
              method: "executeRelayerRefundLeaf",
              args: [rootBundleRelay.rootBundleId, leaf, tree.getHexProof(leaf)],
              message: "Executed RelayerRefundLeaf 🌿!",
              mrkdwn: `rootBundleId: ${rootBundleRelay.rootBundleId}\nrelayerRefundRoot: ${
                rootBundleRelay.relayerRefundRoot
              }\nLeaf: ${leaf.leafId}\nchainId: ${chainId}\ntoken: ${
                leaf.l2TokenAddress
              }\namount: ${leaf.amountToReturn.toString()}`, // Just a placeholder
            });
          });
        }
      })
    );
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
}
