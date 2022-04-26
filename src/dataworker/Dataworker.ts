import { winston, assign, MerkleTree, toBN, compareAddresses, getRefundForFills, sortEventsDescending } from "../utils";
import { RelayerRefundLeaf, RelayerRefundLeafWithGroup, buildRelayerRefundTree, buildSlowRelayTree } from "../utils";
import { getRealizedLpFeeForFills, sortEventsAscending } from "../utils";
import { FillsToRefund, RelayData, UnfilledDeposit, Deposit, Fill, FillWithBlock } from "../interfaces";
import { RunningBalances, BundleEvaluationBlockNumbers } from "../interfaces";
import { DataworkerClients } from "../clients";

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: DataworkerClients,
    readonly chainIdListForBundleEvaluationBlockNumbers: number[]
  ) {}

  // Common data re-formatting logic shared across all data worker public functions.
  _loadData(/* bundleBlockNumbers: BundleEvaluationBlockNumbers */): {
    unfilledDeposits: UnfilledDeposit[];
    fillsToRefund: FillsToRefund;
    allValidFills: FillWithBlock[];
    deposits: Deposit[];
  } {
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    if (!this.clients.configStoreClient.isUpdated) throw new Error(`ConfigStoreClient not updated`);

    const unfilledDepositsForOriginChain: { [originChainIdPlusDepositId: string]: UnfilledDeposit[] } = {};
    const fillsToRefund: FillsToRefund = {};
    const deposits: Deposit[] = [];
    const allValidFills: FillWithBlock[] = [];

    const allChainIds = Object.keys(this.clients.spokePoolClients);
    this.logger.debug({ at: "Dataworker", message: `Loading deposit and fill data`, chainIds: allChainIds });
    for (const originChainId of allChainIds) {
      const originClient = this.clients.spokePoolClients[originChainId];
      if (!originClient.isUpdated) throw new Error(`origin SpokePoolClient on chain ${originChainId} not updated`);

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      this.logger.debug({ at: "Dataworker", message: `Looking up data for origin spoke pool`, originChainId });
      for (const destinationChainId of Object.keys(this.clients.spokePoolClients)) {
        if (originChainId === destinationChainId) continue;

        const destinationClient = this.clients.spokePoolClients[destinationChainId];
        if (!destinationClient.isUpdated)
          throw new Error(`destination SpokePoolClient with chain ID ${destinationChainId} not updated`);

        // Store all deposits, for use in constructing a pool rebalance root.
        deposits.push(...originClient.getDepositsForDestinationChain(destinationChainId));

        // For each fill within the block range, look up associated deposit.
        const fillsForOriginChain: FillWithBlock[] = destinationClient.getFillsWithBlockForOriginChain(
          Number(originChainId)
        );
        this.logger.debug({
          at: "Dataworker",
          message: `Found ${fillsForOriginChain.length} fills for origin chain ${originChainId} on destination client ${destinationChainId}`,
          originChainId,
          destinationChainId,
        });

        fillsForOriginChain.forEach((fillWithBlock) => {
          const matchedDeposit: Deposit = originClient.getDepositForFill(fillWithBlock);
          // Now create a copy of fill with blockNumber removed.
          const { blockNumber, ...fill } = fillWithBlock;

          if (matchedDeposit) {
            // Fill was validated. Save it under all blocks with the block number so we can sort it by time.
            allValidFills.push(fillWithBlock);

            // Handle slow relay where repaymentChainId = 0. Slow relays always pay recipient on destination chain.
            // So, save the slow fill under the destination chain, and save the fast fill under its repayment chain.
            const chainToSendRefundTo = fill.isSlowRelay ? fill.destinationChainId : fill.repaymentChainId;

            // Save fill data and associate with repayment chain and token.
            assign(fillsToRefund, [chainToSendRefundTo, fill.destinationToken, "fills"], [fill]);

            // Update realized LP fee and total refund amount accumulators.
            const refundObj = fillsToRefund[chainToSendRefundTo][fill.destinationToken];
            const refund = getRefundForFills([fill]);
            refundObj.totalRefundAmount = refundObj.totalRefundAmount
              ? refundObj.totalRefundAmount.add(refund)
              : refund;
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
                  hasFirstPartialFill: this._isFirstFillForDeposit(fill)
                },
              ]
            );

            // For non-slow relays, save refund amount for the recipient of the refund, i.e. the relayer
            // for non-slow relays.
            if (!fill.isSlowRelay) {
              // Instantiate dictionary if it doesn't exist.
              if (!refundObj.refunds)
                assign(fillsToRefund, [chainToSendRefundTo, fill.destinationToken, "refunds"], {});

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

    // Remove deposits that have been fully filled from unfilled deposit array
    return { fillsToRefund, deposits, unfilledDeposits, allValidFills };
  }

  buildSlowRelayRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers): MerkleTree<RelayData> | null {
    const { unfilledDeposits } = this._loadData();
    // TODO: Use `bundleBlockNumbers` to decide how to filter which blocks to keep in `unfilledDeposits`.

    if (unfilledDeposits.length === 0) return null;
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
    const sortedLeaves = slowRelayLeaves.sort((relayA, relayB) => {
      // Note: Smaller ID numbers will come first
      if (relayA.originChainId === relayB.originChainId) return relayA.depositId - relayB.depositId;
      else return relayA.originChainId - relayB.originChainId;
    });

    return sortedLeaves.length > 0 ? buildSlowRelayTree(sortedLeaves) : null;
  }

  async publishRoots(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    const slowRelayRoot = await this.buildSlowRelayRoot(bundleBlockNumbers);

    // TODO: Store root to be consumed by manual leaf executors and verifiers. Can also be used to track lifecyle
    // of roots.
  }

  buildRelayerRefundRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers): MerkleTree<RelayerRefundLeaf> | null {
    const { fillsToRefund } = this._loadData();
    if (Object.keys(fillsToRefund).length === 0) return null;

    const relayerRefundLeaves: RelayerRefundLeafWithGroup[] = [];

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
        for (let i = 0; i < sortedRefundAddresses.length; i += this.clients.configStoreClient.maxRefundsPerLeaf)
          relayerRefundLeaves.push({
            groupIndex: i, // Will delete this group index after using it to sort leaves for the same chain ID and
            // L2 token address
            leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
            chainId: Number(repaymentChainId),
            amountToReturn: toBN(0), // TODO: Derive amountToReturn
            l2TokenAddress,
            refundAddresses: sortedRefundAddresses.slice(i, i + this.clients.configStoreClient.maxRefundsPerLeaf),
            refundAmounts: sortedRefundAddresses
              .slice(i, i + this.clients.configStoreClient.maxRefundsPerLeaf)
              .map((address) => refunds[address]),
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

    return indexedLeaves.length > 0 ? buildRelayerRefundTree(indexedLeaves) : null;
  }

  buildPoolRebalanceRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers): {
    runningBalances: RunningBalances;
    realizedLpFees: RunningBalances;
  } {
    const { fillsToRefund, deposits, allValidFills } = this._loadData();

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
    if (Object.keys(fillsToRefund).length > 0) {
      Object.keys(fillsToRefund).forEach((repaymentChainId: string) => {
        Object.keys(fillsToRefund[repaymentChainId]).forEach((l2TokenAddress: string) => {
          const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpart(repaymentChainId, l2TokenAddress);
          assign(
            runningBalances,
            [repaymentChainId, l1TokenCounterpart],
            fillsToRefund[repaymentChainId][l2TokenAddress].totalRefundAmount
          );
          assign(
            realizedLpFees,
            [repaymentChainId, l1TokenCounterpart],
            fillsToRefund[repaymentChainId][l2TokenAddress].realizedLpFees
          );
        });
      });
    }

    // 3. For any executed slow fills, we need to adjust the running balance in case a previous root bundle sent 
    // too many tokens to the spoke pool to pay for the slow fill, but a fill was sent before the slow relay 
    // could be executed, resulting in an excess of funds on the spoke pool.
    // For all slow fills, find the FilledRelay event that originally triggered this slow relay.
    // Recall that slow fills for a deposit are only included in the root bundle if a non-zero amount fill was
    // submitted for that deposit.
    allValidFills.filter(
      (fill: Fill) => fill.isSlowRelay
    ).forEach((slowFill: Fill) => {
      // Find the earliest fill that should have triggered this slow fill to have been published in a root bundle.
      const fillThatTriggeredSlowFill = sortEventsAscending(allValidFills).find(
        (fill: FillWithBlock) =>
          fill.originChainId === slowFill.originChainId && fill.depositId === slowFill.depositId
      ) as FillWithBlock;
      if (!fillThatTriggeredSlowFill) throw new Error("Can't find earliest fill associated with slow fill");
      // Find ending block number for chain from ProposeRootBundle event that should have included this slow fill.
      const endingBlockNumberForRootBundleContainingSlowFill =
        this.clients.hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
          fillThatTriggeredSlowFill.blockNumber,
          fillThatTriggeredSlowFill.destinationChainId,
          this.chainIdListForBundleEvaluationBlockNumbers
        );
      if (!endingBlockNumberForRootBundleContainingSlowFill) throw new Error("Can't find ProposeRootBundle event containing block");
      // Using bundle block number for chain from ProposeRootBundleEvent, find latest fill in the root bundle.
      const lastFillBeforeSlowFillIncludedInRoot = this._matchFillWithFillBeforeBlock(
        slowFill,
        allValidFills,
        endingBlockNumberForRootBundleContainingSlowFill
      );
      if (!lastFillBeforeSlowFillIncludedInRoot)
        throw new Error("Can't find last fill submitted before slow fill was included in root bundle proposal");

      // Recompute how much the matched root bundle sent for this slow fill. Subtract the amount that was
      // actually executed on the L2 from the amount that was sent. This should give us the excess that was sent.
      // Subtract that amount from the running balance so we ultimately send it back to L1.
      const extraFundsSent = lastFillBeforeSlowFillIncludedInRoot.amount
        .sub(lastFillBeforeSlowFillIncludedInRoot.totalFilledAmount)
        .sub(slowFill.fillAmount);
      if (extraFundsSent.eq(toBN(0))) return; // Exit early if slow fill left no excess funds.
      const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpart(
        slowFill.destinationChainId.toString(),
        slowFill.destinationToken
      );
      if (!runningBalances[slowFill.destinationChainId]) runningBalances[slowFill.destinationChainId] = {};
      const runningBalance = runningBalances[slowFill.destinationChainId][l1TokenCounterpart];
      if (runningBalance)
        runningBalances[slowFill.destinationChainId][l1TokenCounterpart] = runningBalance.sub(extraFundsSent);
      else runningBalances[slowFill.destinationChainId][l1TokenCounterpart] = extraFundsSent.mul(toBN(-1));
    });

  //   // TODO: 
  //   // 4. For all fills that completely filled a relay and that followed a partial fill from a previous epoch, we need 
  //   // to decrease running balances by the slow fill amount sent in the previous epoch, since the slow relay was never
  //   // executed, allowing the fill to be sent completely filling the deposit.
    allValidFills.filter(
      (fill: Fill) => !fill.isSlowRelay && fill.totalFilledAmount.eq(fill.amount) && !this._isFirstFillForDeposit(fill)
    ).forEach((fullFill: FillWithBlock) => {
      // If first fill for this deposit is in this epoch, then no slow fill has been sent so we can ignore this full.
      // We can check this by searching for a ProposeRootBundle event with a bundle block range that contains the 
      // first fill for this deposit. If not found, then the first fill is in the current bundle and we can exit early.
      const firstFill = allValidFills.find((fill: FillWithBlock) => this._isFirstFillForDeposit(fill as Fill) && this._filledSameDeposit(fill as Fill, fullFill as Fill))
      console.log(firstFill, this.clients.hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
        firstFill.blockNumber,
        firstFill.destinationChainId,
        this.chainIdListForBundleEvaluationBlockNumbers
      ))
      if (!this.clients.hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
        firstFill.blockNumber,
        firstFill.destinationChainId,
        this.chainIdListForBundleEvaluationBlockNumbers
      )) return;

  //     // If first fill is in a previous epoch, find it and identify the ProposeRootBundle event that included a slow
  //     // fill refund for it.
  //     // Find ending block number for chain from previous ProposeRootBundle event that should have included this slow fill.
  //     const endingBlockNumberForRootBundleContaininSlowFill =
  //       this.clients.hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
  //         firstFill.blockNumber,
  //         firstFill.destinationChainId,
  //         this.chainIdListForBundleEvaluationBlockNumbers
  //       );
  //     // Using bundle block number for chain from ProposeRootBundleEvent, find latest fill in the root bundle.
  //     const lastFillBeforeSlowFillIncludedInRoot = this._matchFillWithFillBeforeBlock(
  //       firstFill,
  //       allValidFills,
  //       endingBlockNumberForRootBundleContaininSlowFill
  //     );
  //     if (!lastFillBeforeSlowFillIncludedInRoot)
  //       throw new Error("Can't find last fill submitted before slow fill was included in root bundle proposal");
  //     // Recompute how much the matched root bundle sent for this slow fill. Subtract the amount that was
  //     // actually executed on the L2 from the amount that was sent. This should give us the excess that was sent.
  //     // Subtract that amount from the running balance so we ultimately send it back to L1.
  //     const extraFundsSent = lastFillBeforeSlowFillIncludedInRoot.amount
  //       .sub(lastFillBeforeSlowFillIncludedInRoot.totalFilledAmount)
  //       .sub(fullFill.fillAmount);
  //     if (extraFundsSent.eq(toBN(0))) return; // Exit early if slow fill left no excess funds.
  //     const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpart(
  //       fullFill.destinationChainId.toString(),
  //       fullFill.destinationToken
  //     );
  //     if (!runningBalances[fullFill.destinationChainId]) runningBalances[fullFill.destinationChainId] = {};
  //     const runningBalance = runningBalances[fullFill.destinationChainId][l1TokenCounterpart];
  //     if (runningBalance)
  //       runningBalances[fullFill.destinationChainId][l1TokenCounterpart] = runningBalance.sub(extraFundsSent);
  //     else runningBalances[fullFill.destinationChainId][l1TokenCounterpart] = extraFundsSent.mul(toBN(-1));
  });

    
    // 4. Map each deposit event to its L1 token and origin chain ID and subtract deposited amounts from running
    // balances. Note that we do not care if the deposit is matched with a fill for this epoch or not since all
    // deposit events lock funds in the spoke pool and should decrease running balances accordingly.
    deposits.forEach((deposit: Deposit) => {
      // TODO: Make sure that we're grabbing the L1 token counterpart at the deposit quote time. This is important if
      // the L1,L2 token mapping is different now than at the quote time.
      const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenForDeposit(deposit);
      if (!runningBalances[deposit.originChainId.toString()]) runningBalances[deposit.originChainId.toString()] = {};
      const runningBalanceForDeposit = runningBalances[deposit.originChainId.toString()][l1TokenCounterpart];
      if (runningBalanceForDeposit)
        runningBalances[deposit.originChainId.toString()][l1TokenCounterpart] = runningBalanceForDeposit.sub(
          deposit.amount
        );
      else runningBalances[deposit.originChainId.toString()][l1TokenCounterpart] = deposit.amount.mul(toBN(-1));
    });

    // 6. Factor in latest RootBundleExecuted.runningBalance before this one.

    // 7. Factor in MAX_POOL_REBALANCE_LEAF_SIZE

    // TODO: Add helpful logs everywhere.

    return {
      runningBalances,
      realizedLpFees,
    };
  }

  async proposeRootBundle(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    // Create roots
    // Store root + auxillary information useful for executing leaves on some storage layer
    // Propose roots to HubPool contract.
  }

  async validateRootBundle(
    bundleBlockNumbers: BundleEvaluationBlockNumbers,
    poolRebalanceRoot: string,
    relayerRefundRoot: string,
    slowRelayRoot: string
  ) {
    this._loadData();

    // Construct roots locally using class functions and compare with input roots.
    // If any roots mismatch, efficiently pinpoint the errors to give details to the caller.
  }

  async executeSlowRelayLeaves(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
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
  _matchFillWithFillBeforeBlock(fillToMatch: Fill, allFills: FillWithBlock[], lastBlock: number): FillWithBlock {
    return sortEventsDescending(allFills).find(
      (fill: FillWithBlock) =>
        !fill.isSlowRelay && lastBlock >= fill.blockNumber && this._filledSameDeposit(fillToMatch, fill as Fill)
    ) as FillWithBlock;
  }
}
