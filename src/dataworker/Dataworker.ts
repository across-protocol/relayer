import { buildRelayerRefundTree, buildSlowRelayTree, buildPoolRebalanceLeafTree } from "../utils";
import { winston, toBN, EMPTY_MERKLE_ROOT } from "../utils";
import { UnfilledDeposit, Deposit, DepositWithBlock, RootBundle, UnfilledDepositsForOriginChain } from "../interfaces";
import { FillWithBlock, PoolRebalanceLeaf, RelayerRefundLeaf, RelayerRefundLeafWithGroup } from "../interfaces";
import { BigNumberForToken, FillsToRefund, RelayData } from "../interfaces";
import { DataworkerClients } from "./DataworkerClientHelper";
import { SpokePoolClient } from "../clients";
import * as PoolRebalanceUtils from "./PoolRebalanceUtils";
import * as RelayerRefundUtils from "./RelayerRefundUtils";
import {
  assignValidFillToFillsToRefund,
  getFillCountGroupedByToken,
  getFillsToRefundCountGroupedByRepaymentChain,
  updateTotalRealizedLpFeePct,
  updateTotalRefundAmount,
} from "./FillUtils";
import { getFillsInRange, getRefundInformationFromFill } from "./FillUtils";
import { getFillCountGroupedByProp } from "./FillUtils";
import { getBlockRangeForChain } from "./DataworkerUtils";
import { getUnfilledDepositCountGroupedByProp, getDepositCountGroupedByToken } from "./DepositUtils";
import { flattenAndFilterUnfilledDepositsByOriginChain } from "./DepositUtils";
import { updateUnfilledDepositsWithMatchedDeposit, getUniqueDepositsInRange } from "./DepositUtils";
import { constructSpokePoolClientsForBlockAndUpdate } from "../common/ClientHelper";

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: DataworkerClients,
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly maxRefundCountOverride: number = undefined,
    readonly maxL1TokenCountOverride: number = undefined,
    readonly tokenTransferThreshold: BigNumberForToken = {},
    readonly blockRangeEndBlockBuffer: { [chainId: number]: number } = {}
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

  // Common data re-formatting logic shared across all data worker public functions.
  // User must pass in spoke pool to search event data against. This allows the user to refund relays and fill deposits
  // on deprecated spoke pools.
  _loadData(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient }
  ): {
    unfilledDeposits: UnfilledDeposit[];
    fillsToRefund: FillsToRefund;
    allValidFills: FillWithBlock[];
    deposits: DepositWithBlock[];
  } {
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
    const deposits: DepositWithBlock[] = [];
    const allValidFills: FillWithBlock[] = [];
    const allInvalidFills: FillWithBlock[] = [];

    const allChainIds = Object.keys(this.clients.spokePoolSigners);
    this.logger.debug({
      at: "Dataworker",
      message: `Loading deposit and fill data`,
      chainIds: allChainIds,
      blockRangesForChains,
    });

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

        // Find all valid fills matching a deposit on the origin chain and sent on the destination chain.
        destinationClient.getFillsWithBlockForOriginChain(Number(originChainId)).forEach((fillWithBlock) => {
          const blockRangeForChain = getBlockRangeForChain(
            blockRangesForChains,
            Number(destinationChainId),
            this.chainIdListForBundleEvaluationBlockNumbers
          );

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
            updateTotalRealizedLpFeePct(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);

            // Save deposit as one that is eligible for a slow fill, since there is a fill
            // for the deposit in this epoch. We save whether this fill is the first fill for the deposit, because
            // if a deposit has its first fill in this block range, then we can send a slow fill payment to complete
            // the deposit. If other fills end up completing this deposit, then we'll remove it from the unfilled
            // deposits later.
            updateUnfilledDepositsWithMatchedDeposit(fill, matchedDeposit, unfilledDepositsForOriginChain);

            // Update total refund counter for convenience when constructing relayer refund leaves
            updateTotalRefundAmount(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);
          } else allInvalidFills.push(fillWithBlock);
        });
      }
    }

    // For each deposit with a matched fill, figure out the unfilled amount that we need to slow relay. We will filter
    // out any deposits that are fully filled.
    const unfilledDeposits = flattenAndFilterUnfilledDepositsByOriginChain(unfilledDepositsForOriginChain);

    const allInvalidFillsInRange = getFillsInRange(
      allInvalidFills,
      blockRangesForChains,
      this.chainIdListForBundleEvaluationBlockNumbers
    );
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesForChains,
      this.chainIdListForBundleEvaluationBlockNumbers
    );
    this.logger.debug({
      at: "Dataworker",
      message: `Finished loading spoke pool data`,
      blockRangesForChains,
      depositsInRangeByOriginChain: getDepositCountGroupedByToken(deposits),
      allValidFillsInRangeByDestinationChain: getFillCountGroupedByToken(allValidFillsInRange),
      fillsToRefundInRangeByRepaymentChain: getFillsToRefundCountGroupedByRepaymentChain(fillsToRefund),
      unfilledDepositsByDestinationChain: getUnfilledDepositCountGroupedByProp(unfilledDeposits, "destinationChainId"),
      allValidFillsByDestinationChain: getFillCountGroupedByProp(allValidFills, "destinationChainId"),
      allInvalidFillsInRangeByDestinationChain: getFillCountGroupedByToken(allInvalidFillsInRange),
    });

    if (allInvalidFillsInRange.length > 0)
      this.logger.info({
        at: "Dataworker",
        message: `Finished loading spoke pool data and found some invalid fills in range`,
        blockRangesForChains,
        allInvalidFillsInRangeByDestinationChain: getFillCountGroupedByProp(
          allInvalidFillsInRange,
          "destinationChainId"
        ),
      });

    // Remove deposits that have been fully filled from unfilled deposit array
    return { fillsToRefund, deposits, unfilledDeposits, allValidFills };
  }

  buildSlowRelayRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    this.logger.debug({ at: "Dataworker", message: `Building slow relay root`, blockRangesForChains });

    const { unfilledDeposits } = this._loadData(blockRangesForChains, spokePoolClients);
    const slowRelayLeaves: RelayData[] = unfilledDeposits.map(
      (deposit: UnfilledDeposit): RelayData => ({
        depositor: deposit.deposit.depositor,
        recipient: deposit.deposit.recipient,
        destinationToken: deposit.deposit.destinationToken,
        amount: deposit.deposit.amount,
        originChainId: deposit.deposit.originChainId,
        destinationChainId: deposit.deposit.destinationChainId,
        realizedLpFeePct: deposit.deposit.realizedLpFeePct,
        relayerFeePct: deposit.deposit.relayerFeePct,
        depositId: deposit.deposit.depositId,
      })
    );

    // Sort leaves deterministically so that the same root is always produced from the same _loadData return value.
    // The { Deposit ID, origin chain ID } is guaranteed to be unique so we can sort on them.
    const sortedLeaves = [...slowRelayLeaves].sort((relayA, relayB) => {
      // Note: Smaller ID numbers will come first
      if (relayA.originChainId === relayB.originChainId) return relayA.depositId - relayB.depositId;
      else return relayA.originChainId - relayB.originChainId;
    });

    return {
      leaves: sortedLeaves,
      tree: buildSlowRelayTree(sortedLeaves),
    };
  }

  buildRelayerRefundRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    this.logger.debug({ at: "Dataworker", message: `Building relayer refund root`, blockRangesForChains });
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForChains,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    const { fillsToRefund } = this._loadData(blockRangesForChains, spokePoolClients);

    const relayerRefundLeaves: RelayerRefundLeafWithGroup[] = [];

    // We need to construct a pool rebalance root in order to derive `amountToReturn` from `netSendAmount`.
    const poolRebalanceRoot = this.buildPoolRebalanceRoot(blockRangesForChains, spokePoolClients);

    // We'll construct a new leaf for each { repaymentChainId, L2TokenAddress } unique combination.
    Object.keys(fillsToRefund).forEach((repaymentChainId: string) => {
      Object.keys(fillsToRefund[repaymentChainId]).forEach((l2TokenAddress: string) => {
        const refunds = fillsToRefund[repaymentChainId][l2TokenAddress].refunds;
        // We need to sort leaves deterministically so that the same root is always produced from the same _loadData
        // return value, so sort refund addresses by refund amount (descending) and then address (ascending).
        const sortedRefundAddresses = RelayerRefundUtils.sortRefundAddresses(refunds);

        // Create leaf for { repaymentChainId, L2TokenAddress }, split leaves into sub-leaves if there are too many
        // refunds.
        const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpartAtBlock(
          repaymentChainId,
          l2TokenAddress,
          endBlockForMainnet
        );
        const transferThreshold =
          this.tokenTransferThreshold[l1TokenCounterpart] ||
          this.clients.configStoreClient.getTokenTransferThresholdForBlock(l1TokenCounterpart, endBlockForMainnet);

        // The `amountToReturn` for a { repaymentChainId, L2TokenAddress} should be set to max(-netSendAmount, 0).
        const amountToReturn = RelayerRefundUtils.getAmountToReturnForRelayerRefundLeaf(
          transferThreshold,
          poolRebalanceRoot.runningBalances[repaymentChainId][l1TokenCounterpart]
        );
        const maxRefundCount = this.maxRefundCountOverride
          ? this.maxRefundCountOverride
          : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
        for (let i = 0; i < sortedRefundAddresses.length; i += maxRefundCount)
          relayerRefundLeaves.push({
            groupIndex: i, // Will delete this group index after using it to sort leaves for the same chain ID and
            // L2 token address
            amountToReturn: i === 0 ? amountToReturn : toBN(0),
            chainId: Number(repaymentChainId),
            refundAmounts: sortedRefundAddresses.slice(i, i + maxRefundCount).map((address) => refunds[address]),
            leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
            l2TokenAddress,
            refundAddresses: sortedRefundAddresses.slice(i, i + maxRefundCount),
          });
      });
    });

    // We need to construct a leaf for any pool rebalance leaves with a negative net send amount and NO fills to refund
    // since we need to return tokens from SpokePool to HubPool.
    poolRebalanceRoot.leaves.forEach((leaf) => {
      leaf.netSendAmounts.forEach((netSendAmount, index) => {
        if (netSendAmount.gte(toBN(0))) return;

        const l2TokenCounterpart = this.clients.hubPoolClient.getDestinationTokenForL1TokenDestinationChainId(
          leaf.l1Tokens[index],
          leaf.chainId
        );
        // If we've already seen this leaf, then skip.
        if (
          relayerRefundLeaves.some(
            (relayerRefundLeaf) =>
              relayerRefundLeaf.chainId === leaf.chainId && relayerRefundLeaf.l2TokenAddress === l2TokenCounterpart
          )
        )
          return;
        const transferThreshold =
          this.tokenTransferThreshold[leaf.l1Tokens[index]] ||
          this.clients.configStoreClient.getTokenTransferThresholdForBlock(leaf.l1Tokens[index], endBlockForMainnet);
        const amountToReturn = RelayerRefundUtils.getAmountToReturnForRelayerRefundLeaf(
          transferThreshold,
          poolRebalanceRoot.runningBalances[leaf.chainId][leaf.l1Tokens[index]]
        );
        relayerRefundLeaves.push({
          groupIndex: 0, // Will delete this group index after using it to sort leaves for the same chain ID and
          // L2 token address
          leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
          chainId: leaf.chainId,
          amountToReturn: amountToReturn, // Never 0 since there will only be one leaf for this chain + L2 token combo.
          l2TokenAddress: l2TokenCounterpart,
          refundAddresses: [],
          refundAmounts: [],
        });
      });
    });

    const indexedLeaves: RelayerRefundLeaf[] = RelayerRefundUtils.sortRelayerRefundLeaves(relayerRefundLeaves);
    return {
      leaves: indexedLeaves,
      tree: buildRelayerRefundTree(indexedLeaves),
    };
  }

  buildPoolRebalanceRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    this.logger.debug({ at: "Dataworker", message: `Building pool rebalance root`, blockRangesForChains });

    const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = this._loadData(
      blockRangesForChains,
      spokePoolClients
    );

    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForChains,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    // Running balances are the amount of tokens that we need to send to each SpokePool to pay for all instant and
    // slow relay refunds. They are decreased by the amount of funds already held by the SpokePool. Balances are keyed
    // by the SpokePool's network and L1 token equivalent of the L2 token to refund.
    // Realized LP fees are keyed the same as running balances and represent the amount of LP fees that should be paid
    // to LP's for each running balance.

    // For each FilledRelay group, identified by { repaymentChainId, L1TokenAddress }, initialize a "running balance"
    // to the total refund amount for that group.
    const { runningBalances, realizedLpFees } = PoolRebalanceUtils.initializeRunningBalancesFromRelayerRepayments(
      endBlockForMainnet,
      this.clients.hubPoolClient,
      fillsToRefund
    );

    // Add payments to execute slow fills.
    PoolRebalanceUtils.addSlowFillsToRunningBalances(
      endBlockForMainnet,
      runningBalances,
      this.clients.hubPoolClient,
      unfilledDeposits
    );

    // For certain fills associated with another partial fill from a previous root bundle, we need to adjust running
    // balances because the prior partial fill would have triggered a refund to be sent to the spoke pool to refund
    // a slow fill.
    PoolRebalanceUtils.subtractExcessFromPreviousSlowFillsFromRunningBalances(
      runningBalances,
      this.clients.hubPoolClient,
      allValidFills,
      this.chainIdListForBundleEvaluationBlockNumbers
    );

    // Map each deposit event to its L1 token and origin chain ID and subtract deposited amounts from running
    // balances. Note that we do not care if the deposit is matched with a fill for this epoch or not since all
    // deposit events lock funds in the spoke pool and should decrease running balances accordingly. However,
    // its important that `deposits` are all in this current block range.
    deposits.forEach((deposit: DepositWithBlock) => {
      PoolRebalanceUtils.updateRunningBalanceForDeposit(
        runningBalances,
        this.clients.hubPoolClient,
        deposit,
        deposit.amount.mul(toBN(-1))
      );
    });

    // Add to the running balance value from the last valid root bundle proposal for {chainId, l1Token}
    // combination if found.
    PoolRebalanceUtils.addLastRunningBalance(endBlockForMainnet, runningBalances, this.clients.hubPoolClient);

    const leaves: PoolRebalanceLeaf[] = PoolRebalanceUtils.constructPoolRebalanceLeaves(
      endBlockForMainnet,
      runningBalances,
      realizedLpFees,
      this.clients.configStoreClient,
      this.maxL1TokenCountOverride,
      this.tokenTransferThreshold
    );

    return {
      runningBalances,
      realizedLpFees,
      leaves,
      tree: buildPoolRebalanceLeafTree(leaves),
    };
  }

  async proposeRootBundle() {
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
    this.logger.debug({
      at: "Dataworker#propose",
      message: `Constructing spoke pool clients for end mainnet block in bundle range`,
      endBlockForMainnet,
    });
    const spokePoolClients = await constructSpokePoolClientsForBlockAndUpdate(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.clients,
      this.logger,
      endBlockForMainnet
    );

    // 3. Create roots
    const poolRebalanceRoot = this.buildPoolRebalanceRoot(blockRangesForProposal, spokePoolClients);
    PoolRebalanceUtils.prettyPrintLeaves(
      this.logger,
      poolRebalanceRoot.tree,
      poolRebalanceRoot.leaves,
      "Pool rebalance"
    );
    const relayerRefundRoot = this.buildRelayerRefundRoot(blockRangesForProposal, spokePoolClients);
    PoolRebalanceUtils.prettyPrintLeaves(
      this.logger,
      relayerRefundRoot.tree,
      relayerRefundRoot.leaves,
      "Relayer refund"
    );
    const slowRelayRoot = this.buildSlowRelayRoot(blockRangesForProposal, spokePoolClients);
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

  async validatePendingRootBundle() {
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;

    // Exit early if a bundle is not pending.
    if (!this.clients.hubPoolClient.hasPendingProposal()) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "No pending proposal, nothing to validate",
      });
      return;
    }

    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundleProposal();
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
      });
      return;
    }

    const widestPossibleExpectedBlockRange = await PoolRebalanceUtils.getWidestPossibleExpectedBlockRange(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.clients,
      this.clients.hubPoolClient.latestBlockNumber
    );
    const { valid, reason } = await this.validateRootBundle(
      hubPoolChainId,
      widestPossibleExpectedBlockRange,
      pendingRootBundle
    );
    if (!valid) this._submitDisputeWithMrkdwn(hubPoolChainId, reason);
  }

  async validateRootBundle(
    hubPoolChainId: number,
    widestPossibleExpectedBlockRange: number[][],
    rootBundle: RootBundle
  ): Promise<{ valid: boolean; reason?: string }> {
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

    // These buffers can be configured by the bot runner. These are used to validate the end blocks specified in the
    // pending root bundle. If the end block is greater than the latest block for its chain, then we should dispute the
    // bundle because we can't look up events in the future for that chain. However, there are some cases where the
    // proposer's node for that chain is returning a higher HEAD block than the bot-runner is seeing, so we can
    // use this buffer to allow the proposer some margin of error. If the bundle end block is less than HEAD but within
    // this buffer, then we won't dispute and we'll just exit early from this function.
    const endBlockBuffers = this.chainIdListForBundleEvaluationBlockNumbers.map(
      (chainId: number) => this.blockRangeEndBlockBuffer[chainId] ?? 0
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
    this.logger.debug({
      at: "Dataworker#validate",
      message: `Constructing spoke pool clients for end mainnet block in bundle range`,
      endBlockForMainnet,
    });
    const spokePoolClients = await constructSpokePoolClientsForBlockAndUpdate(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.clients,
      this.logger,
      endBlockForMainnet
    );

    // Compare roots with expected. The roots will be different if the block range start blocks were different
    // than the ones we constructed above when the original proposer submitted their proposal. The roots will also
    // be different if the events on any of the contracts were different.
    const expectedPoolRebalanceRoot = this.buildPoolRebalanceRoot(
      blockRangesImpliedByBundleEndBlocks,
      spokePoolClients
    );
    const expectedRelayerRefundRoot = this.buildRelayerRefundRoot(
      blockRangesImpliedByBundleEndBlocks,
      spokePoolClients
    );
    const expectedSlowRelayRoot = this.buildSlowRelayRoot(blockRangesImpliedByBundleEndBlocks, spokePoolClients);
    if (
      expectedPoolRebalanceRoot.leaves.length !== rootBundle.unclaimedPoolRebalanceLeafCount ||
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
    };
  }

  async executeSlowRelayLeaves() {
    // TODO: Caller should grab `bundleBlockNumbers` from ProposeRootBundle event, recreate root and execute
    // all leaves for root. To locate `rootBundleId`, look up `SpokePool.RelayedRootBundle` events and find event
    // with matching roots.
  }

  async executePoolRebalanceLeaves() {
    // TODO:
  }

  async executeRelayerRefundLeaves() {
    // TODO:
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
      this.logger.error({ at: "Dataworker", message: "Error creating proposeRootBundleTx", error });
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
      this.logger.error({ at: "Dataworker", message: "Error creating disputeRootBundleTx", error });
    }
  }
}
