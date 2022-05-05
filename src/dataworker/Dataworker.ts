import { winston, assign, MerkleTree, compareAddresses, getRefundForFills, sortEventsDescending } from "../utils";
import { buildRelayerRefundTree, buildSlowRelayTree, buildPoolRebalanceLeafTree } from "../utils";
import { getRealizedLpFeeForFills, BigNumber, toBN } from "../utils";
import { FillsToRefund, RelayData, UnfilledDeposit, Deposit, DepositWithBlock } from "../interfaces";
import { Fill, FillWithBlock, PoolRebalanceLeaf, RelayerRefundLeaf, RelayerRefundLeafWithGroup } from "../interfaces";
import { RunningBalances } from "../interfaces";
import { DataworkerClients } from "./DataworkerClientHelper";

// TODO!!!: Add helpful logs everywhere.

// TODO: Need to handle case where there are multiple spoke pools for a chain ID in a given block range, which would
// happen if a spoke pool was upgraded. Probably need to make spokePoolClients also keyed by block number in addition
// to chain ID.

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
  _loadData(blockRangesForChains: number[][]): {
    unfilledDeposits: UnfilledDeposit[];
    fillsToRefund: FillsToRefund;
    allValidFills: FillWithBlock[];
    deposits: DepositWithBlock[];
  } {
    // TODO: Test `blockRangesForChains`
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    if (!this.clients.configStoreClient.isUpdated) throw new Error(`ConfigStoreClient not updated`);

    const unfilledDepositsForOriginChain: { [originChainIdPlusDepositId: string]: UnfilledDeposit[] } = {};
    const fillsToRefund: FillsToRefund = {};
    const deposits: DepositWithBlock[] = [];
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

        const blockRangeForChain = this._getBlockRangeForChain(blockRangesForChains, Number(destinationChainId));

        // Store all deposits, for use in constructing a pool rebalance root. Save deposits with their quote time block
        // numbers so we can pull the L1 token counterparts for the quote timestamp. We don't filter deposits
        // by block range, only fills.
        deposits.push(...originClient.getDepositsForDestinationChain(destinationChainId, true));

        // For each fill within the block range, look up associated deposit.
        const fillsForOriginChain: FillWithBlock[] = destinationClient
          .getFillsWithBlockForOriginChain(Number(originChainId))
          .filter(
            (fill: FillWithBlock) =>
              fill.blockNumber <= blockRangeForChain[1] && fill.blockNumber >= blockRangeForChain[0]
          );
        this.logger.debug({
          at: "Dataworker",
          message: `Found ${fillsForOriginChain.length} fills for origin chain ${originChainId} on destination client ${destinationChainId}`,
          originChainId,
          destinationChainId,
        });

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

            // Save fill data and associate with repayment chain and token.
            assign(fillsToRefund, [chainToSendRefundTo, fill.destinationToken, "fills"], [fill]);

            // Update realized LP fee accumulator for slow and non-slow fills.
            const refundObj = fillsToRefund[chainToSendRefundTo][fill.destinationToken];
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

  buildSlowRelayRoot(blockRangesForChains: number[][]) {
    // TODO: Test `blockRangesForChains`

    const { unfilledDeposits } = this._loadData(blockRangesForChains);
    // TODO: Use `bundleBlockNumbers` to decide how to filter which blocks to keep in `unfilledDeposits`.

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

    if (sortedLeaves.length === 0) throw new Error("Cannot build tree with zero leaves");
    return {
      leaves: sortedLeaves,
      tree: buildSlowRelayTree(sortedLeaves),
    };
  }

  async publishRoots(blockRangesForChains: number[][]) {
    // TODO: Store root to be consumed by manual leaf executors and verifiers. Can also be used to track lifecyle
    // of roots.
  }

  buildRelayerRefundRoot(blockRangesForChains: number[][]) {
    // TODO: Test `blockRangesForChains`

    const { fillsToRefund } = this._loadData(blockRangesForChains);

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
        // TODO: Replace the block height hardcoded with a block from the bundle block range so we can look up the
        // limit at the time of the proposal.
        const endBlockForMainnet = this._getBlockRangeForChain(blockRangesForChains, 1)[1];
        const maxRefundCount =
          this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
        for (let i = 0; i < sortedRefundAddresses.length; i += maxRefundCount)
          relayerRefundLeaves.push({
            groupIndex: i, // Will delete this group index after using it to sort leaves for the same chain ID and
            // L2 token address
            leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
            chainId: Number(repaymentChainId),
            amountToReturn: toBN(0), // TODO: Derive amountToReturn
            l2TokenAddress,
            refundAddresses: sortedRefundAddresses.slice(i, i + maxRefundCount),
            refundAmounts: sortedRefundAddresses.slice(i, i + maxRefundCount).map((address) => refunds[address]),
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

    if (indexedLeaves.length === 0) throw new Error("Cannot build tree with zero leaves");
    return {
      leaves: indexedLeaves,
      tree: buildRelayerRefundTree(indexedLeaves),
    };
  }

  buildPoolRebalanceRoot(blockRangesForChains: number[][]) {
    // TODO: Test `blockRangesForChains`

    const { fillsToRefund, deposits, allValidFills } = this._loadData(blockRangesForChains);

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
        const maxRefundCount =
          this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
        for (let i = 0; i < sortedL1Tokens.length; i += maxRefundCount) {
          const l1TokensToIncludeInThisLeaf = sortedL1Tokens.slice(i, i + maxRefundCount);

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

    if (leaves.length === 0) throw new Error("Cannot build tree with zero leaves");
    const tree = buildPoolRebalanceLeafTree(leaves);

    return {
      runningBalances,
      realizedLpFees,
      leaves,
      tree,
    };
  }

  async proposeRootBundle() {
    // 1. Construct a list of ending block ranges for each chain that we want to include
    // relay events for. The ending block numbers for these ranges will be added to a "bundleEvaluationBlockNumbers"
    // list, and the order of chain ID's is hardcoded in the ConfigStore client.
    const blockRangesForProposal = this.chainIdListForBundleEvaluationBlockNumbers.map((chainId: number) => [
      this.clients.hubPoolClient.getNextBundleStartBlockNumber(
        this.chainIdListForBundleEvaluationBlockNumbers,
        this.clients.hubPoolClient.latestBlockNumber,
        chainId
      ),
      this.clients.spokePoolClients[chainId].latestBlockNumber,
    ]);

    // TODO:
    // 2. Create roots
    const poolRebalanceRoot = this.buildPoolRebalanceRoot(blockRangesForProposal);
    console.log(`poolRebalanceRoot:`, poolRebalanceRoot.leaves, poolRebalanceRoot.tree);
    const relayerRefundRoot = this.buildRelayerRefundRoot(blockRangesForProposal);
    console.log(`relayerRefundRoot:`, relayerRefundRoot.leaves, relayerRefundRoot.tree);
    const slowRelayRoot = this.buildSlowRelayRoot(blockRangesForProposal);
    console.log(`slowRelayRoot:`, slowRelayRoot.leaves, slowRelayRoot.tree);

    // 3. Store root + auxillary information somewhere useful for executing leaves
    // 4. Propose roots to HubPool contract.
  }

  async validateRootBundle(poolRebalanceRoot: string, relayerRefundRoot: string, slowRelayRoot: string) {
    // Look at latest propose root bundle event earlier than a block number
    // Construct roots locally using class functions and compare with the event we found earlier.
    // If any roots mismatch, pinpoint the errors to give details to the caller.
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

  // If the running balance is greater than the token transfer threshold, then set the net send amount
  // equal to the running balance and reset the running balance to 0. Otherwise, the net send amount should be
  // 0, indicating that we do not want the data worker to trigger a token transfer between hub pool and spoke
  // pool when executing this leaf.
  _getNetSendAmountForL1Token(runningBalance: BigNumber, l1Token: string, mainnetBlock: number): BigNumber {
    return runningBalance
      .abs()
      .gte(this.clients.configStoreClient.getTokenTransferThresholdForBlock(l1Token, mainnetBlock))
      ? runningBalance
      : toBN(0);
  }

  _getRunningBalanceForL1Token(runningBalance: BigNumber, l1Token: string, mainnetBlock: number): BigNumber {
    return runningBalance
      .abs()
      .lt(this.clients.configStoreClient.getTokenTransferThresholdForBlock(l1Token, mainnetBlock))
      ? runningBalance
      : toBN(0);
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
