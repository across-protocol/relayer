import { winston, assign, compareAddresses, getRefundForFills, sortEventsDescending, Contract } from "../utils";
import { buildRelayerRefundTree, buildSlowRelayTree, buildPoolRebalanceLeafTree, SpokePool } from "../utils";
import { getRealizedLpFeeForFills, BigNumber, toBN, convertFromWei, shortenHexString } from "../utils";
import { shortenHexStrings, EMPTY_MERKLE_ROOT } from "../utils";
import { FillsToRefund, RelayData, UnfilledDeposit, Deposit, DepositWithBlock, RootBundle } from "../interfaces";
import { Fill, FillWithBlock, PoolRebalanceLeaf, RelayerRefundLeaf, RelayerRefundLeafWithGroup } from "../interfaces";
import { RunningBalances } from "../interfaces";
import { DataworkerClients } from "./DataworkerClientHelper";
import { SpokePoolClient } from "../clients";

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
    readonly tokenTransferThreshold: { [l1TokenAddress: string]: BigNumber } = {},
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

    const unfilledDepositsForOriginChain: { [originChainIdPlusDepositId: string]: UnfilledDeposit[] } = {};
    const fillsToRefund: FillsToRefund = {};
    const deposits: DepositWithBlock[] = [];
    const allValidFills: FillWithBlock[] = [];

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
        const depositChainBlockRange = this._getBlockRangeForChain(blockRangesForChains, Number(originChainId));
        const newDeposits: DepositWithBlock[] = originClient
          .getDepositsForDestinationChain(destinationChainId, true)
          .filter(
            (deposit) =>
              deposit.originBlockNumber <= depositChainBlockRange[1] &&
              deposit.originBlockNumber >= depositChainBlockRange[0] &&
              !deposits.some(
                (existingDeposit) =>
                  existingDeposit.originChainId === deposit.originChainId &&
                  existingDeposit.depositId === deposit.depositId
              )
          );
        deposits.push(...newDeposits);

        // For each fill within the block range, look up associated deposit.
        const blockRangeForChain = this._getBlockRangeForChain(blockRangesForChains, Number(destinationChainId));
        const fillsForOriginChain: FillWithBlock[] = destinationClient
          .getFillsWithBlockForOriginChain(Number(originChainId))
          .filter(
            (fill: FillWithBlock) =>
              fill.blockNumber <= blockRangeForChain[1] && fill.blockNumber >= blockRangeForChain[0]
          );

        fillsForOriginChain.forEach((fillWithBlock) => {
          const matchedDeposit: Deposit = originClient.getDepositForFill(fillWithBlock);
          // Now create a copy of fill with block data removed.
          const { blockNumber, transactionIndex, logIndex, ...fill } = fillWithBlock;

          if (matchedDeposit) {
            // Fill was validated. Save it under all validated fills list with the block number so we can sort it by
            // time.
            allValidFills.push(fillWithBlock);

            // Handle slow relay where repaymentChainId = 0. Slow relays always pay recipient on destination chain.
            // So, save the slow fill under the destination chain, and save the fast fill under its repayment chain.
            const chainToSendRefundTo = fill.isSlowRelay ? fill.destinationChainId : fill.repaymentChainId;

            // Save fill data and associate with repayment chain and L2 token refund should be denominated in.
            const endBlockForMainnet = this._getBlockRangeForChain(blockRangesForChains, 1)[1];
            const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpartAtBlock(
              fill.destinationChainId.toString(),
              fill.destinationToken,
              endBlockForMainnet
            );
            const repaymentToken = this.clients.hubPoolClient.getDestinationTokenForL1TokenDestinationChainId(
              l1TokenCounterpart,
              chainToSendRefundTo
            );
            assign(fillsToRefund, [chainToSendRefundTo, repaymentToken, "fills"], [fill]);

            // Update realized LP fee accumulator for slow and non-slow fills.
            const refundObj = fillsToRefund[chainToSendRefundTo][repaymentToken];
            refundObj.realizedLpFees = refundObj.realizedLpFees
              ? refundObj.realizedLpFees.add(getRealizedLpFeeForFills([fill]))
              : getRealizedLpFeeForFills([fill]);

            // Save deposit as one that we'll include a slow fill for, since there is a non-slow fill
            // for the deposit in this epoch.
            const depositUnfilledAmount = fill.amount.sub(fill.totalFilledAmount);
            const depositKey = `${originChainId}+${fill.depositId}`;
            assign(
              unfilledDepositsForOriginChain,
              [depositKey],
              [
                {
                  unfilledAmount: depositUnfilledAmount,
                  deposit: matchedDeposit,
                  // A first partial fill for a deposit is characterized by one whose total filled amount post-fill
                  // is equal to the amount sent in the fill, and where the fill amount is greater than zero.
                  hasFirstPartialFill: this._isFirstFillForDeposit(fill),
                },
              ]
            );

            // For non-slow relays, save refund amount for the recipient of the refund, i.e. the relayer
            // for non-slow relays.
            if (!fill.isSlowRelay) {
              // Update total refund amount for non-slow fills, since refunds for executed slow fills would have been
              // included in a previous root bundle.
              const refund = getRefundForFills([fill]);
              refundObj.totalRefundAmount = refundObj.totalRefundAmount
                ? refundObj.totalRefundAmount.add(refund)
                : refund;

              // Instantiate dictionary if it doesn't exist.
              if (!refundObj.refunds) assign(fillsToRefund, [chainToSendRefundTo, repaymentToken, "refunds"], {});

              if (refundObj.refunds[fill.relayer])
                refundObj.refunds[fill.relayer] = refundObj.refunds[fill.relayer].add(refund);
              else refundObj.refunds[fill.relayer] = refund;
            }
          } else {
            this.logger.debug({
              at: "Dataworker",
              message: `Could not find deposit for fill on origin client`,
              fill,
            });
          }
        });
      }
    }

    // For each deposit with a matched fill, figure out the unfilled amount that we need to slow relay. We will filter
    // out any deposits that are fully filled, or any deposits that were already slow relayed in a previous epoch.
    const unfilledDeposits = Object.values(unfilledDepositsForOriginChain)
      .map((_unfilledDeposits: UnfilledDeposit[]): UnfilledDeposit => {
        // Remove deposits with no matched fills.
        if (_unfilledDeposits.length === 0) return { unfilledAmount: toBN(0), deposit: undefined };
        // Remove deposits where there isn't a fill with fillAmount == totalFilledAmount && fillAmount > 0. This ensures
        // that we'll only be slow relaying deposits where the first fill (i.e. the one with
        // fillAmount == totalFilledAmount) is in this epoch. We assume that we already included slow fills in a
        // previous epoch for these ignored deposits.
        if (
          !_unfilledDeposits.some((_unfilledDeposit: UnfilledDeposit) => _unfilledDeposit.hasFirstPartialFill === true)
        )
          return { unfilledAmount: toBN(0), deposit: undefined };
        // For each deposit, identify the smallest unfilled amount remaining after a fill since each fill can
        // only decrease the unfilled amount.
        _unfilledDeposits.sort((unfilledDepositA, unfilledDepositB) =>
          unfilledDepositA.unfilledAmount.gt(unfilledDepositB.unfilledAmount)
            ? 1
            : unfilledDepositA.unfilledAmount.lt(unfilledDepositB.unfilledAmount)
            ? -1
            : 0
        );
        return { unfilledAmount: _unfilledDeposits[0].unfilledAmount, deposit: _unfilledDeposits[0].deposit };
      })
      // Remove deposits that are fully filled
      .filter((unfilledDeposit: UnfilledDeposit) => unfilledDeposit.unfilledAmount.gt(0));

    this.logger.debug({
      at: "Dataworker",
      message: `Finished loading spoke pool data`,
      blockRangesForChains,
      unfilledDepositsByDestinationChain: unfilledDeposits.reduce((result, unfilledDeposit: UnfilledDeposit) => {
        const existingCount = result[unfilledDeposit.deposit.destinationChainId];
        result[unfilledDeposit.deposit.destinationChainId] = existingCount === undefined ? 1 : existingCount + 1;
        return result;
      }, {}),
      depositsByOriginChain: deposits.reduce((result, deposit: DepositWithBlock) => {
        const existingCount = result[deposit.originChainId];
        result[deposit.originChainId] = existingCount === undefined ? 1 : existingCount + 1;
        return result;
      }, {}),
      fillsToRefundByRepaymentChain: Object.keys(fillsToRefund).reduce((endResult, repaymentChain) => {
        endResult[repaymentChain] = endResult[repaymentChain] ?? {};
        return Object.keys(fillsToRefund[repaymentChain]).reduce((result, repaymentToken) => {
          const existingCount = result[repaymentChain][repaymentToken];
          const fillCount = fillsToRefund[repaymentChain][repaymentToken].fills.length;
          result[repaymentChain][repaymentToken] = existingCount === undefined ? fillCount : existingCount + fillCount;
          return result;
        }, endResult);
      }, {}),
      allValidFillsByDestinationChain: allValidFills.reduce((result, fill: FillWithBlock) => {
        const existingCount = result[fill.destinationChainId];
        result[fill.destinationChainId] = existingCount === undefined ? 1 : existingCount + 1;
        return result;
      }, {}),
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
    const endBlockForMainnet = this._getBlockRangeForChain(blockRangesForChains, 1)[1];

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
        const sortedRefundAddresses = Object.keys(refunds).sort((addressA, addressB) => {
          if (refunds[addressA].gt(refunds[addressB])) return -1;
          if (refunds[addressA].lt(refunds[addressB])) return 1;
          const sortOutput = compareAddresses(addressA, addressB);
          if (sortOutput !== 0) return sortOutput;
          else throw new Error("Unexpected matching address");
        });

        // Create leaf for { repaymentChainId, L2TokenAddress }, split leaves into sub-leaves if there are too many
        // refunds.

        // The `amountToReturn` for a { repaymentChainId, L2TokenAddress} should be set to max(-netSendAmount, 0).
        const amountToReturn = this._getAmountToReturnForRelayerRefundLeaf(
          endBlockForMainnet,
          repaymentChainId,
          l2TokenAddress,
          poolRebalanceRoot.runningBalances
        );
        const maxRefundCount = this.maxRefundCountOverride
          ? this.maxRefundCountOverride
          : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
        for (let i = 0; i < sortedRefundAddresses.length; i += maxRefundCount)
          relayerRefundLeaves.push({
            groupIndex: i, // Will delete this group index after using it to sort leaves for the same chain ID and
            // L2 token address
            leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
            chainId: Number(repaymentChainId),
            amountToReturn: i === 0 ? amountToReturn : toBN(0),
            l2TokenAddress,
            refundAddresses: sortedRefundAddresses.slice(i, i + maxRefundCount),
            refundAmounts: sortedRefundAddresses.slice(i, i + maxRefundCount).map((address) => refunds[address]),
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

        const amountToReturn = this._getAmountToReturnForRelayerRefundLeaf(
          endBlockForMainnet,
          leaf.chainId.toString(),
          l2TokenCounterpart,
          poolRebalanceRoot.runningBalances
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

    // Sort leaves by chain ID and then L2 token address in ascending order. Assign leaves unique, ascending ID's
    // beginning from 0.
    const indexedLeaves: RelayerRefundLeaf[] = [...relayerRefundLeaves]
      .sort((leafA, leafB) => {
        if (leafA.chainId !== leafB.chainId) {
          return leafA.chainId - leafB.chainId;
        } else if (compareAddresses(leafA.l2TokenAddress, leafB.l2TokenAddress) !== 0) {
          return compareAddresses(leafA.l2TokenAddress, leafB.l2TokenAddress);
        } else if (leafA.groupIndex !== leafB.groupIndex) return leafA.groupIndex - leafB.groupIndex;
        else throw new Error("Unexpected leaf group indices match");
      })
      .map((leaf: RelayerRefundLeafWithGroup, i: number): RelayerRefundLeaf => {
        delete leaf.groupIndex; // Delete group index now that we've used it to sort leaves for the same
        // { repaymentChain, l2TokenAddress } since it doesn't exist in RelayerRefundLeaf
        return { ...leaf, leafId: i };
      });

    return {
      leaves: indexedLeaves,
      tree: buildRelayerRefundTree(indexedLeaves),
    };
  }

  buildPoolRebalanceRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    this.logger.debug({ at: "Dataworker", message: `Building pool rebalance root`, blockRangesForChains });

    const { fillsToRefund, deposits, allValidFills } = this._loadData(blockRangesForChains, spokePoolClients);

    // Running balances are the amount of tokens that we need to send to each SpokePool to pay for all instant and
    // slow relay refunds. They are decreased by the amount of funds already held by the SpokePool. Balances are keyed
    // by the SpokePool's network and L1 token equivalent of the L2 token to refund.
    const runningBalances: RunningBalances = {};
    // Realized LP fees are keyed the same as running balances and represent the amount of LP fees that should be paid
    // to LP's for each running balance.
    const realizedLpFees: RunningBalances = {};

    // 1. For each FilledRelay group, identified by { repaymentChainId, L1TokenAddress }, initialize a "running balance"
    // to the total refund amount for that group.
    // 2. Similarly, for each group sum the realized LP fees.
    const endBlockForMainnet = this._getBlockRangeForChain(blockRangesForChains, 1)[1];

    if (Object.keys(fillsToRefund).length > 0) {
      Object.keys(fillsToRefund).forEach((repaymentChainId: string) => {
        Object.keys(fillsToRefund[repaymentChainId]).forEach((l2TokenAddress: string) => {
          const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpartAtBlock(
            repaymentChainId,
            l2TokenAddress,
            endBlockForMainnet
          );
          assign(
            realizedLpFees,
            [repaymentChainId, l1TokenCounterpart],
            fillsToRefund[repaymentChainId][l2TokenAddress].realizedLpFees
          );

          // Start with latest RootBundleExecuted.runningBalance for {chainId, l1Token} combination if found.
          const startingRunningBalance = this.clients.hubPoolClient.getRunningBalanceBeforeBlockForChain(
            endBlockForMainnet,
            Number(repaymentChainId),
            l1TokenCounterpart
          );

          // totalRefundAmount won't exist for chains that only had slow fills, so we should explicitly check for it.
          if (fillsToRefund[repaymentChainId][l2TokenAddress].totalRefundAmount)
            assign(
              runningBalances,
              [repaymentChainId, l1TokenCounterpart],
              startingRunningBalance.add(fillsToRefund[repaymentChainId][l2TokenAddress].totalRefundAmount)
            );
        });
      });
    }

    // For certain fills associated with another partial fill from a previous root bundle, we need to adjust running
    // balances because the prior partial fill would have triggered a refund to be sent to the spoke pool to refund
    // a slow fill.
    allValidFills.forEach((fill: FillWithBlock) => {
      const firstFillForSameDeposit = allValidFills.find(
        (_fill: FillWithBlock) => this._isFirstFillForDeposit(_fill as Fill) && this._filledSameDeposit(_fill, fill)
      );
      if (firstFillForSameDeposit === undefined) {
        // If there is no first fill associated with a slow fill, then something is wrong because we assume that slow
        // fills can only be sent after at least one non-zero partial fill is submitted for a deposit.
        if (fill.isSlowRelay) throw new Error("Can't find earliest fill associated with slow fill");
        // If there is no first fill associated with the current partial fill, then it must be the first fill and we'll
        // skip it because there are running balance adjustments to make for this type of fill.
        else return;
      }
      // Find ending block number for chain from ProposeRootBundle event that should have included a slow fill
      // refund for this first fill. This will be undefined if there is no block range containing the first fill.
      const rootBundleEndBlockContainingFirstFill =
        this.clients.hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
          firstFillForSameDeposit.blockNumber,
          firstFillForSameDeposit.destinationChainId,
          this.chainIdListForBundleEvaluationBlockNumbers
        );
      // Using bundle block number for chain from ProposeRootBundleEvent, find latest fill in the root bundle.
      let lastFillBeforeSlowFillIncludedInRoot;
      if (rootBundleEndBlockContainingFirstFill !== undefined) {
        lastFillBeforeSlowFillIncludedInRoot = this._getLastMatchingFillBeforeBlock(
          fill,
          allValidFills,
          rootBundleEndBlockContainingFirstFill
        );
      }

      // 3. For any executed slow fills, we need to decrease the running balance if a previous root bundle sent
      // tokens to the spoke pool to pay for the slow fill, but a partial fill was sent before the slow relay
      // could be executed, resulting in an excess of funds on the spoke pool.
      if (fill.isSlowRelay) {
        // Since every slow fill should have a partial fill that came before it, we should always be able to find the
        // last partial fill for the root bundle including the slow fill refund.
        if (!lastFillBeforeSlowFillIncludedInRoot)
          throw new Error("Can't find last fill submitted before slow fill was included in root bundle proposal");

        // Recompute how much the matched root bundle sent for this slow fill. Subtract the amount that was
        // actually executed on the L2 from the amount that was sent. This should give us the excess that was sent.
        // Subtract that amount from the running balance so we ultimately send it back to L1.
        const amountSentForSlowFill = lastFillBeforeSlowFillIncludedInRoot.amount.sub(
          lastFillBeforeSlowFillIncludedInRoot.totalFilledAmount
        );
        const excess = amountSentForSlowFill.sub(fill.fillAmount);
        if (excess.eq(toBN(0))) return; // Exit early if slow fill left no excess funds.
        this._updateRunningBalanceForFill(runningBalances, fill, excess.mul(toBN(-1)));
      }
      // 4. For all fills that completely filled a relay and that followed a partial fill from a previous epoch, we need
      // to decrease running balances by the slow fill amount sent in the previous epoch, since the slow relay was never
      // executed, allowing the fill to be sent completely filling the deposit.
      else if (fill.totalFilledAmount.eq(fill.amount)) {
        // If first fill for this deposit is in this epoch, then no slow fill has been sent so we can ignore this fill.
        // We can check this by searching for a ProposeRootBundle event with a bundle block range that contains the
        // first fill for this deposit. If it is the same as the ProposeRootBundle event containing the
        // current fill, then the first fill is in the current bundle and we can exit early.
        const rootBundleEndBlockContainingFullFill =
          this.clients.hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
            fill.blockNumber,
            fill.destinationChainId,
            this.chainIdListForBundleEvaluationBlockNumbers
          );
        if (rootBundleEndBlockContainingFirstFill === rootBundleEndBlockContainingFullFill) return;

        // If full fill and first fill are in different blocks, then we should always be able to find the last partial
        // fill included in the root bundle that also included the slow fill refund.
        if (!lastFillBeforeSlowFillIncludedInRoot)
          throw new Error("Can't find last fill submitted before slow fill was included in root bundle proposal");

        // Recompute how much the matched root bundle sent for this slow fill. This slow fill refund needs to be sent
        // back to the hub because it was completely replaced by partial fills submitted after the root bundle
        // proposal. We know that there was no slow fill execution because the `fullFill` completely filled the deposit,
        // meaning that no slow fill was executed before it, and no slow fill can be executed after it.
        const amountSentForSlowFill = lastFillBeforeSlowFillIncludedInRoot.amount.sub(
          lastFillBeforeSlowFillIncludedInRoot.totalFilledAmount
        );
        this._updateRunningBalanceForFill(runningBalances, fill, amountSentForSlowFill.mul(toBN(-1)));
      }
    });

    // 5. Map each deposit event to its L1 token and origin chain ID and subtract deposited amounts from running
    // balances. Note that we do not care if the deposit is matched with a fill for this epoch or not since all
    // deposit events lock funds in the spoke pool and should decrease running balances accordingly.
    deposits.forEach((deposit: DepositWithBlock) => {
      this._updateRunningBalanceForDeposit(runningBalances, deposit, deposit.amount.mul(toBN(-1)));
    });

    // 6. Create one leaf per L2 chain ID. First we'll create a leaf with all L1 tokens for each chain ID, and then
    // we'll split up any leaves with too many L1 tokens.
    const leaves: PoolRebalanceLeaf[] = [];
    Object.keys(runningBalances)
      // Leaves should be sorted by ascending chain ID
      .sort((chainIdA, chainIdB) => Number(chainIdA) - Number(chainIdB))
      .map((chainId: string) => {
        // Sort addresses.
        const sortedL1Tokens = Object.keys(runningBalances[chainId]).sort((addressA, addressB) => {
          return compareAddresses(addressA, addressB);
        });

        // This begins at 0 and increments for each leaf for this { chainId, L1Token } combination.
        let groupIndexForChainId = 0;

        // Split addresses into multiple leaves if there are more L1 tokens than allowed per leaf.
        const maxL1TokensPerLeaf = this.maxL1TokenCountOverride
          ? this.maxL1TokenCountOverride
          : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
        for (let i = 0; i < sortedL1Tokens.length; i += maxL1TokensPerLeaf) {
          const l1TokensToIncludeInThisLeaf = sortedL1Tokens.slice(i, i + maxL1TokensPerLeaf);

          leaves.push({
            groupIndex: groupIndexForChainId++,
            leafId: leaves.length,
            chainId: Number(chainId),
            bundleLpFees: realizedLpFees[chainId]
              ? l1TokensToIncludeInThisLeaf.map((l1Token) => realizedLpFees[chainId][l1Token])
              : Array(l1TokensToIncludeInThisLeaf.length).fill(toBN(0)),
            runningBalances: runningBalances[chainId]
              ? l1TokensToIncludeInThisLeaf.map((l1Token) =>
                  this._getRunningBalanceForL1Token(runningBalances[chainId][l1Token], l1Token, endBlockForMainnet)
                )
              : Array(l1TokensToIncludeInThisLeaf.length).fill(toBN(0)),
            netSendAmounts: runningBalances[chainId]
              ? l1TokensToIncludeInThisLeaf.map((l1Token) =>
                  this._getNetSendAmountForL1Token(runningBalances[chainId][l1Token], l1Token, endBlockForMainnet)
                )
              : Array(l1TokensToIncludeInThisLeaf.length).fill(toBN(0)),
            l1Tokens: l1TokensToIncludeInThisLeaf,
          });
        }
      });

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
        at: "Dataworker",
        message: "Has pending proposal, cannot propose",
      });
      return;
    }

    // 1. Construct a list of ending block ranges for each chain that we want to include
    // relay events for. The ending block numbers for these ranges will be added to a "bundleEvaluationBlockNumbers"
    // list, and the order of chain ID's is hardcoded in the ConfigStore client.
    const blockRangesForProposal = await this._getWidestPossibleExpectedBlockRange();

    // 2. Construct spoke pool clients using spoke pools deployed at end of block range.
    // We do make an assumption that the spoke pool contract was not changed during the block range. By using the
    // spoke pool at this block instead of assuming its the currently deployed one, we can pay refunds for deposits
    // on deprecated spoke pools.
    const endBlockForMainnet = this._getBlockRangeForChain(blockRangesForProposal, 1)[1];
    this.logger.debug({
      at: "Dataworker",
      message: `Constructing spoke pool clients for end mainnet block in bundle range`,
      endBlockForMainnet,
    });
    const spokePoolClients = await this._constructSpokePoolClientsForBlockAndUpdate(endBlockForMainnet);

    // 3. Create roots
    const poolRebalanceRoot = this.buildPoolRebalanceRoot(blockRangesForProposal, spokePoolClients);
    poolRebalanceRoot.leaves.forEach((leaf: PoolRebalanceLeaf, index) => {
      const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
        // Check if leaf value is list of BN's. For this leaf, there are no BN's not in lists.
        if (BigNumber.isBigNumber(leaf[key][0])) result[key] = leaf[key].map((val) => val.toString());
        else result[key] = leaf[key];
        return result;
      }, {});
      this.logger.debug({
        at: "Dataworker",
        message: `Pool rebalance leaf #${index}`,
        prettyLeaf,
        proof: poolRebalanceRoot.tree.getHexProof(leaf),
      });
      return prettyLeaf;
    });
    const relayerRefundRoot = this.buildRelayerRefundRoot(blockRangesForProposal, spokePoolClients);
    relayerRefundRoot.leaves.forEach((leaf: RelayerRefundLeaf, index) => {
      const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
        // Check if leaf value is list of BN's or single BN.
        if (Array.isArray(leaf[key]) && BigNumber.isBigNumber(leaf[key][0]))
          result[key] = leaf[key].map((val) => val.toString());
        else if (BigNumber.isBigNumber(leaf[key])) result[key] = leaf[key].toString();
        else result[key] = leaf[key];
        return result;
      }, {});
      this.logger.debug({
        at: "Dataworker",
        message: `Relayer refund leaf #${index}`,
        leaf: prettyLeaf,
        proof: relayerRefundRoot.tree.getHexProof(leaf),
      });
    });
    const slowRelayRoot = this.buildSlowRelayRoot(blockRangesForProposal, spokePoolClients);
    slowRelayRoot.leaves.forEach((leaf: RelayData, index) => {
      const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
        // Check if leaf value is BN.
        if (BigNumber.isBigNumber(leaf[key])) result[key] = leaf[key].toString();
        else result[key] = leaf[key];
        return result;
      }, {});
      this.logger.debug({
        at: "Dataworker",
        message: `Slow relay leaf #${index}`,
        leaf: prettyLeaf,
        proof: slowRelayRoot.tree.getHexProof(leaf),
      });
    });

    if (poolRebalanceRoot.leaves.length === 0) {
      this.logger.debug({
        at: "Dataworker",
        message: "No pool rebalance leaves, cannot propose",
      });
      return;
    }

    // 4. Propose roots to HubPool contract.
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;
    this.logger.debug({
      at: "Dataworker",
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

  async validateRootBundle() {
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;

    // Exit early if a bundle is pending.
    if (!this.clients.hubPoolClient.hasPendingProposal()) {
      this.logger.debug({
        at: "Dataworker",
        message: "No pending proposal, nothing to validate",
      });
      return;
    }

    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundleProposal();
    this.logger.info({
      at: "Dataworker",
      message: "Validating pending proposal",
      pendingRootBundle,
    });

    // Exit early if challenge period timestamp has passed:
    if (this.clients.hubPoolClient.currentTime > pendingRootBundle.challengePeriodEndTimestamp) {
      this.logger.debug({
        at: "Dataworker",
        message: "Challenge period passed, cannot dispute",
      });
      return;
    }

    // If pool rebalance root is empty, always dispute. There should never be a bundle with an empty rebalance root.
    if (pendingRootBundle.poolRebalanceRoot === EMPTY_MERKLE_ROOT) {
      this.logger.debug({
        at: "Dataworker",
        message: "Empty pool rebalance root, submitting dispute",
        pendingRootBundle,
      });
      this._submitDisputeWithMrkdwn(hubPoolChainId, `Disputed pending root bundle with empty pool rebalance root`);
      return;
    }

    // First, we'll evaluate the pending root bundle's block end numbers.
    const widestPossibleExpectedBlockRange = await this._getWidestPossibleExpectedBlockRange();

    // Make sure that all end blocks are >= expected start blocks.
    if (
      pendingRootBundle.bundleEvaluationBlockNumbers.some(
        (block, index) => block < widestPossibleExpectedBlockRange[index][0]
      )
    ) {
      this.logger.debug({
        at: "Dataworker",
        message: "A bundle end block is < expected start block, submitting dispute",
        expectedStartBlocks: widestPossibleExpectedBlockRange.map((range) => range[0]),
        pendingEndBlocks: pendingRootBundle.bundleEvaluationBlockNumbers,
      });
      this._submitDisputeWithMrkdwn(
        hubPoolChainId,
        this._generateMarkdownForDisputeInvalidBundleBlocks(pendingRootBundle, widestPossibleExpectedBlockRange)
      );
      return;
    }

    const endBlockBuffers = this.chainIdListForBundleEvaluationBlockNumbers.map(
      (chainId: number) => this.blockRangeEndBlockBuffer[chainId] ?? 0
    );
    // Make sure that all end blocks are <= latest HEAD blocks + buffer for all chains.
    if (
      pendingRootBundle.bundleEvaluationBlockNumbers.some(
        (block, index) => block > widestPossibleExpectedBlockRange[index][1] + endBlockBuffers[index]
      )
    ) {
      this.logger.debug({
        at: "Dataworker",
        message: "A bundle end block is > latest block for its chain, submitting dispute",
        expectedEndBlocks: widestPossibleExpectedBlockRange.map((range) => range[1]),
        pendingEndBlocks: pendingRootBundle.bundleEvaluationBlockNumbers,
      });
      this._submitDisputeWithMrkdwn(
        hubPoolChainId,
        this._generateMarkdownForDisputeInvalidBundleBlocks(pendingRootBundle, widestPossibleExpectedBlockRange)
      );
      return;
    }

    // We use the block number at which the root bundle was proposed as the "latest mainnet block" in
    // order to determine the start blocks. This means that the hub pool client will first look up the latest
    // RootBundleExecuted event before this proposal root block in order to find the preceding ProposeRootBundle's
    // end block.
    const blockRangesImpliedByBundleEndBlocks = widestPossibleExpectedBlockRange.map((blockRange, index) => [
      blockRange[0],
      pendingRootBundle.bundleEvaluationBlockNumbers[index],
    ]);

    this.logger.info({
      at: "Dataworker",
      message: "Implied bundle ranges",
      blockRangesImpliedByBundleEndBlocks,
      chainIdListForBundleEvaluationBlockNumbers: this.chainIdListForBundleEvaluationBlockNumbers,
    });

    // Construct spoke pool clients using spoke pools deployed at end of block range.
    // We do make an assumption that the spoke pool contract was not changed during the block range. By using the
    // spoke pool at this block instead of assuming its the currently deployed one, we can pay refunds for deposits
    // on deprecated spoke pools.
    const endBlockForMainnet = this._getBlockRangeForChain(blockRangesImpliedByBundleEndBlocks, 1)[1];
    this.logger.debug({
      at: "Dataworker",
      message: `Constructing spoke pool clients for end mainnet block in bundle range`,
      endBlockForMainnet,
    });
    const spokePoolClients = await this._constructSpokePoolClientsForBlockAndUpdate(endBlockForMainnet);

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
      expectedPoolRebalanceRoot.leaves.length !== pendingRootBundle.unclaimedPoolRebalanceLeafCount ||
      expectedPoolRebalanceRoot.tree.getHexRoot() !== pendingRootBundle.poolRebalanceRoot
    ) {
      this.logger.debug({
        at: "Dataworker",
        message: "Unexpected pool rebalance root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedPoolRebalanceLeaves: expectedPoolRebalanceRoot.leaves,
        expectedPoolRebalanceRoot: expectedPoolRebalanceRoot.tree.getHexRoot(),
        pendingRoot: pendingRootBundle.poolRebalanceRoot,
        pendingPoolRebalanceLeafCount: pendingRootBundle.unclaimedPoolRebalanceLeafCount,
      });
    } else if (expectedRelayerRefundRoot.tree.getHexRoot() !== pendingRootBundle.relayerRefundRoot) {
      this.logger.debug({
        at: "Dataworker",
        message: "Unexpected relayer refund root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedRelayerRefundRoot: expectedRelayerRefundRoot.tree.getHexRoot(),
        pendingRoot: pendingRootBundle.relayerRefundRoot,
      });
    } else if (expectedSlowRelayRoot.tree.getHexRoot() !== pendingRootBundle.slowRelayRoot) {
      this.logger.debug({
        at: "Dataworker",
        message: "Unexpected slow relay root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedSlowRelayRoot: expectedSlowRelayRoot.tree.getHexRoot(),
        pendingRoot: pendingRootBundle.slowRelayRoot,
      });
    } else {
      // All roots are valid! Exit early.
      this.logger.debug({
        at: "Dataworker",
        message: "Pending root bundle matches with expected",
      });
      return;
    }

    this._submitDisputeWithMrkdwn(
      hubPoolChainId,
      this._generateMarkdownForDispute(pendingRootBundle) +
        `\n` +
        this._generateMarkdownForRootBundle(
          hubPoolChainId,
          blockRangesImpliedByBundleEndBlocks,
          [...expectedPoolRebalanceRoot.leaves],
          expectedPoolRebalanceRoot.tree.getHexRoot(),
          [...expectedRelayerRefundRoot.leaves],
          expectedRelayerRefundRoot.tree.getHexRoot(),
          [...expectedSlowRelayRoot.leaves],
          expectedSlowRelayRoot.tree.getHexRoot()
        )
    );
  }

  // This returns a possible next block range that could be submitted as a new root bundle, or used as a reference
  // when evaluating  pending root bundle. The block end numbers must be less than the latest blocks for each chain ID
  // (because we can't evaluate events in the future), and greater than the the expected start blocks, which are the
  // greater of 0 and the latest bundle end block for an executed root bundle proposal + 1.
  async _getWidestPossibleExpectedBlockRange(): Promise<number[][]> {
    const latestBlockNumbers = await Promise.all(
      this.chainIdListForBundleEvaluationBlockNumbers.map((chainId: number) =>
        this.clients.spokePoolSigners[chainId].provider.getBlockNumber()
      )
    );
    return this.chainIdListForBundleEvaluationBlockNumbers.map((chainId: number, index) => [
      this.clients.hubPoolClient.getNextBundleStartBlockNumber(
        this.chainIdListForBundleEvaluationBlockNumbers,
        this.clients.hubPoolClient.latestBlockNumber,
        chainId
      ),
      latestBlockNumbers[index],
    ]);
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
        mrkdwn: this._generateMarkdownForRootBundle(
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

  _generateMarkdownForRootBundle(
    hubPoolChainId: number,
    bundleBlockRange: number[][],
    poolRebalanceLeaves: any[],
    poolRebalanceRoot: string,
    relayerRefundLeaves: any[],
    relayerRefundRoot: string,
    slowRelayLeaves: any[],
    slowRelayRoot: string
  ): string {
    // Create helpful logs to send to slack transport
    let bundleBlockRangePretty = "";
    this.chainIdListForBundleEvaluationBlockNumbers.forEach((chainId, index) => {
      bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(bundleBlockRange[index])}`;
    });

    const convertTokenListFromWei = (chainId: number, tokenAddresses: string[], weiVals: string[]) => {
      return tokenAddresses.map((token, index) => {
        const { decimals } = this.clients.hubPoolClient.getTokenInfo(chainId, token);
        return convertFromWei(weiVals[index], decimals);
      });
    };
    const convertTokenAddressToSymbol = (chainId: number, tokenAddress: string) => {
      return this.clients.hubPoolClient.getTokenInfo(chainId, tokenAddress).symbol;
    };
    const convertL1TokenAddressesToSymbols = (l1Tokens: string[]) => {
      return l1Tokens.map((l1Token) => {
        return convertTokenAddressToSymbol(hubPoolChainId, l1Token);
      });
    };
    let poolRebalanceLeavesPretty = "";
    poolRebalanceLeaves.forEach((leaf, index) => {
      // Shorten keys for ease of reading from Slack.
      delete leaf.leafId;
      leaf.groupId = leaf.groupIndex;
      delete leaf.groupIndex;
      leaf.bundleLpFees = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.bundleLpFees);
      leaf.runningBalances = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.runningBalances);
      leaf.netSendAmounts = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.netSendAmounts);
      leaf.l1Tokens = convertL1TokenAddressesToSymbols(leaf.l1Tokens);
      poolRebalanceLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
    });

    let relayerRefundLeavesPretty = "";
    relayerRefundLeaves.forEach((leaf, index) => {
      // Shorten keys for ease of reading from Slack.
      delete leaf.leafId;
      leaf.amountToReturn = convertFromWei(
        leaf.amountToReturn,
        this.clients.hubPoolClient.getTokenInfo(leaf.chainId, leaf.l2TokenAddress).decimals
      );
      leaf.refundAmounts = convertTokenListFromWei(
        leaf.chainId,
        Array(leaf.refundAmounts.length).fill(leaf.l2TokenAddress),
        leaf.refundAmounts
      );
      leaf.l2Token = convertTokenAddressToSymbol(leaf.chainId, leaf.l2TokenAddress);
      delete leaf.l2TokenAddress;
      leaf.refundAddresses = shortenHexStrings(leaf.refundAddresses);
      relayerRefundLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
    });

    let slowRelayLeavesPretty = "";
    slowRelayLeaves.forEach((leaf, index) => {
      const decimalsForDestToken = this.clients.hubPoolClient.getTokenInfo(
        leaf.destinationChainId,
        leaf.destinationToken
      ).decimals;
      // Shorten keys for ease of reading from Slack.
      delete leaf.leafId;
      leaf.originChain = leaf.originChainId;
      leaf.destinationChain = leaf.destinationChainId;
      leaf.depositor = shortenHexString(leaf.depositor);
      leaf.recipient = shortenHexString(leaf.recipient);
      leaf.destToken = convertTokenAddressToSymbol(leaf.destinationChainId, leaf.destinationToken);
      leaf.amount = convertFromWei(leaf.amount, decimalsForDestToken);
      leaf.realizedLpFee = `${convertFromWei(leaf.realizedLpFeePct, decimalsForDestToken)}%`;
      leaf.relayerFee = `${convertFromWei(leaf.relayerFeePct, decimalsForDestToken)}%`;
      delete leaf.destinationToken;
      delete leaf.realizedLpFeePct;
      delete leaf.relayerFeePct;
      delete leaf.originChainId;
      delete leaf.destinationChainId;
      slowRelayLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
    });
    return (
      `\n\t*Bundle blocks*:${bundleBlockRangePretty}` +
      `\n\t*PoolRebalance*:\n\t\troot:${shortenHexString(
        poolRebalanceRoot
      )}...\n\t\tleaves:${poolRebalanceLeavesPretty}` +
      `\n\t*RelayerRefund*\n\t\troot:${shortenHexString(
        relayerRefundRoot
      )}...\n\t\tleaves:${relayerRefundLeavesPretty}` +
      `\n\t*SlowRelay*\n\troot:${shortenHexString(slowRelayRoot)}...\n\t\tleaves:${slowRelayLeavesPretty}`
    );
  }

  _generateMarkdownForDispute(pendingRootBundle: RootBundle) {
    return (
      `Disputed pending root bundle:` +
      `\n\tPoolRebalance leaf count: ${pendingRootBundle.unclaimedPoolRebalanceLeafCount}` +
      `\n\tPoolRebalance root: ${shortenHexString(pendingRootBundle.poolRebalanceRoot)}` +
      `\n\tRelayerRefund root: ${shortenHexString(pendingRootBundle.relayerRefundRoot)}` +
      `\n\tSlowRelay root: ${shortenHexString(pendingRootBundle.slowRelayRoot)}` +
      `\n\tProposer: ${shortenHexString(pendingRootBundle.proposer)}`
    );
  }

  _generateMarkdownForDisputeInvalidBundleBlocks(pendingRootBundle: RootBundle, widestExpectedBlockRange: number[][]) {
    const getBlockRangePretty = (blockRange: number[][] | number[]) => {
      let bundleBlockRangePretty = "";
      blockRange.forEach((chainId, index) => {
        bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(blockRange[index])}`;
      });
      return bundleBlockRangePretty;
    };
    return (
      `Disputed pending root bundle because of invalid bundle blocks:` +
      `\n\t*Widest possible expected block range*:${getBlockRangePretty(widestExpectedBlockRange)}` +
      `\n\t*Pending end blocks*:${getBlockRangePretty(pendingRootBundle.bundleEvaluationBlockNumbers)}`
    );
  }

  _getAmountToReturnForRelayerRefundLeaf(
    endBlockForMainnet: number,
    leafChainId: string,
    leafToken: string,
    poolRebalanceRunningBalances: RunningBalances
  ) {
    const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpartAtBlock(
      leafChainId,
      leafToken,
      endBlockForMainnet
    );
    const runningBalanceForLeaf = poolRebalanceRunningBalances[leafChainId][l1TokenCounterpart];
    const netSendAmountForLeaf = this._getNetSendAmountForL1Token(
      runningBalanceForLeaf,
      l1TokenCounterpart,
      endBlockForMainnet
    );
    return netSendAmountForLeaf.mul(toBN(-1)).gt(toBN(0)) ? netSendAmountForLeaf.mul(toBN(-1)) : toBN(0);
  }

  // If the running balance is greater than the token transfer threshold, then set the net send amount
  // equal to the running balance and reset the running balance to 0. Otherwise, the net send amount should be
  // 0, indicating that we do not want the data worker to trigger a token transfer between hub pool and spoke
  // pool when executing this leaf.
  _getNetSendAmountForL1Token(runningBalance: BigNumber, l1Token: string, mainnetBlock: number): BigNumber {
    const transferThreshold = this.tokenTransferThreshold[l1Token]
      ? this.tokenTransferThreshold[l1Token]
      : this.clients.configStoreClient.getTokenTransferThresholdForBlock(l1Token, mainnetBlock);
    return runningBalance.abs().gte(transferThreshold) ? runningBalance : toBN(0);
  }

  _getRunningBalanceForL1Token(runningBalance: BigNumber, l1Token: string, mainnetBlock: number): BigNumber {
    const transferThreshold = this.tokenTransferThreshold[l1Token]
      ? this.tokenTransferThreshold[l1Token]
      : this.clients.configStoreClient.getTokenTransferThresholdForBlock(l1Token, mainnetBlock);
    return runningBalance.abs().lt(transferThreshold) ? runningBalance : toBN(0);
  }

  _updateRunningBalance(runningBalances: RunningBalances, l2ChainId: number, l1Token: string, updateAmount: BigNumber) {
    // Initialize dictionary if empty.
    if (!runningBalances[l2ChainId]) runningBalances[l2ChainId] = {};
    const runningBalance = runningBalances[l2ChainId][l1Token];
    if (runningBalance) runningBalances[l2ChainId][l1Token] = runningBalance.add(updateAmount);
    else runningBalances[l2ChainId][l1Token] = updateAmount;
  }

  _updateRunningBalanceForFill(runningBalances: RunningBalances, fill: FillWithBlock, updateAmount: BigNumber) {
    const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpartAtBlock(
      fill.destinationChainId.toString(),
      fill.destinationToken,
      fill.blockNumber
    );
    this._updateRunningBalance(runningBalances, fill.destinationChainId, l1TokenCounterpart, updateAmount);
  }

  _updateRunningBalanceForDeposit(runningBalances, deposit: DepositWithBlock, updateAmount: BigNumber) {
    const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpartAtBlock(
      deposit.originChainId.toString(),
      deposit.originToken,
      deposit.blockNumber
    );
    this._updateRunningBalance(runningBalances, deposit.originChainId, l1TokenCounterpart, updateAmount);
  }

  _isFirstFillForDeposit(fill: Fill): boolean {
    return fill.fillAmount.eq(fill.totalFilledAmount) && fill.fillAmount.gt(toBN(0));
  }

  _filledSameDeposit(fillA: Fill, fillB: Fill): boolean {
    return (
      fillA.amount.eq(fillB.amount) &&
      fillA.originChainId === fillB.originChainId &&
      fillA.destinationChainId === fillB.destinationChainId &&
      fillA.relayerFeePct.eq(fillB.relayerFeePct) &&
      fillA.depositId === fillB.depositId &&
      fillA.recipient === fillB.recipient &&
      fillA.depositor === fillB.depositor
    );
  }

  // Return fill with matching relay data as slow fill that emitted before the `lastBlock`.
  _getLastMatchingFillBeforeBlock(fillToMatch: Fill, allFills: FillWithBlock[], lastBlock: number): FillWithBlock {
    return sortEventsDescending(allFills).find(
      (fill: FillWithBlock) =>
        !fill.isSlowRelay && lastBlock >= fill.blockNumber && this._filledSameDeposit(fillToMatch, fill)
    ) as FillWithBlock;
  }

  async _constructSpokePoolClientsForBlockAndUpdate(
    latestMainnetBlock: number
  ): Promise<{ [chainId: number]: SpokePoolClient }> {
    const spokePoolClients = Object.fromEntries(
      this.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
        const spokePoolContract = new Contract(
          this.clients.hubPoolClient.getSpokePoolForBlock(latestMainnetBlock, Number(chainId)),
          SpokePool.abi,
          this.clients.spokePoolSigners[chainId]
        );
        const client = new SpokePoolClient(
          this.logger,
          spokePoolContract,
          this.clients.configStoreClient,
          Number(chainId),
          this.clients.spokePoolClientSearchSettings[chainId]
        );
        return [chainId, client];
      })
    );
    await Promise.all(Object.values(spokePoolClients).map((client: SpokePoolClient) => client.update()));
    return spokePoolClients;
  }

  _getBlockRangeForChain(blockRange: number[][], chain: number): number[] {
    const indexForChain = this.chainIdListForBundleEvaluationBlockNumbers.indexOf(chain);
    if (indexForChain === -1)
      throw new Error(
        `Could not find chain ${chain} in chain ID list ${this.chainIdListForBundleEvaluationBlockNumbers}`
      );
    const blockRangeForChain = blockRange[indexForChain];
    if (!blockRangeForChain || blockRangeForChain.length !== 2)
      throw new Error(`Invalid block range for chain ${chain}`);
    return blockRangeForChain;
  }
}
