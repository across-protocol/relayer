import { winston, assign, buildSlowRelayTree, MerkleTree, toBN, compareAddresses, getRefundForFills } from "../utils";
import { RelayerRefundLeaf, RelayerRefundLeafWithGroup, BigNumber, buildRelayerRefundTree } from "../utils";
import { getRealizedLpFeeForFills } from "../utils";
import { FillsToRefund, RelayData, UnfilledDeposit, Deposit, Fill, BundleEvaluationBlockNumbers } from "../interfaces";
import { RunningBalances } from "../interfaces";
import { DataworkerClients } from "../clients";

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  // eslint-disable-next-line no-useless-constructor
  constructor(readonly logger: winston.Logger, readonly clients: DataworkerClients) {}

  // Common data re-formatting logic shared across all data worker public functions.
  _loadData(/* bundleBlockNumbers: BundleEvaluationBlockNumbers */): {
    unfilledDeposits: UnfilledDeposit[];
    fillsToRefund: FillsToRefund;
    slowFills: Fill[];
    deposits: Deposit[];
  } {
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    if (!this.clients.configStoreClient.isUpdated) throw new Error(`ConfigStoreClient not updated`);

    const unfilledDepositsForOriginChain: { [originChainIdPlusDepositId: string]: UnfilledDeposit[] } = {};
    const fillsToRefund: FillsToRefund = {};
    const deposits: Deposit[] = [];
    const slowFills: Fill[] = [];

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
        const fillsForOriginChain: Fill[] = destinationClient.getFillsForOriginChain(Number(originChainId));
        this.logger.debug({
          at: "Dataworker",
          message: `Found ${fillsForOriginChain.length} fills for origin chain ${originChainId} on destination client ${destinationChainId}`,
          originChainId,
          destinationChainId,
        });

        fillsForOriginChain.forEach((fill) => {
          const matchedDeposit: Deposit = originClient.getDepositForFill(fill);
          if (matchedDeposit) {
            // FillRelay events emitted by slow relay executions will usually not match with any deposits because the
            // relayer fee % will be reset to 0 by the SpokePool contract, however we still need to explicitly filter slow
            // relays out because its possible that a deposit is submitted with a relayer fee % set to 0.
            if (!fill.isSlowRelay) {
              // Save fill data and associate with repayment chain and token.
              assign(fillsToRefund, [fill.repaymentChainId, fill.destinationToken, "fills"], [fill]);

              // Update refund amount for the recipient of the refund, i.e. the relayer.
              const refund = getRefundForFills([fill]);
              const refundObj = fillsToRefund[fill.repaymentChainId][fill.destinationToken];
              const refunds = refundObj.refunds;
              if (!refunds) {
                // Initiate refunds dictionary if it doesn't exist.
                assign(fillsToRefund, [fill.repaymentChainId, fill.destinationToken, "refunds"], {});
                refundObj.refunds[fill.relayer] = refund;
              } else if (refunds[fill.relayer]) refunds[fill.relayer] = refunds[fill.relayer].add(refund);
              else refunds[fill.relayer] = refund;

              // Update realized LP fee and total refund amount accumulators.
              refundObj.totalRefundAmount = refundObj.totalRefundAmount
                ? refundObj.totalRefundAmount.add(refund)
                : refund;
              refundObj.realizedLpFees = refundObj.realizedLpFees
                ? refundObj.realizedLpFees.add(getRealizedLpFeeForFills([fill]))
                : getRealizedLpFeeForFills([fill]);
            } else slowFills.push(fill);
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
                  hasFirstPartialFill: fill.fillAmount.eq(fill.totalFilledAmount) && fill.fillAmount.gt(toBN(0)),
                },
              ]
            );
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
        // that we'll only be slow relaying deposits where the first fill
        // (i.e. the one with fillAmount == totalFilledAmount) is in this epoch.
        if (
          !_unfilledDeposits.some((_unfilledDeposit: UnfilledDeposit) => _unfilledDeposit.hasFirstPartialFill === true)
        )
          return { unfilledAmount: toBN(0), deposit: undefined };
        // Take the smallest unfilled amount since each fill can only decrease the unfilled amount.
        _unfilledDeposits.sort((unfilledDepositA, unfilledDepositB) =>
          unfilledDepositA.unfilledAmount.gt(unfilledDepositB.unfilledAmount)
            ? 1
            : unfilledDepositA.unfilledAmount.lt(unfilledDepositB.unfilledAmount)
            ? -1
            : 0
        );
        return { unfilledAmount: _unfilledDeposits[0].unfilledAmount, deposit: _unfilledDeposits[0].deposit };
      })
      .filter((unfilledDeposit: UnfilledDeposit) => unfilledDeposit.unfilledAmount.gt(0));

    // Remove deposits that have been fully filled from unfilled deposit array
    return { fillsToRefund, deposits, unfilledDeposits, slowFills };
  }

  buildSlowRelayRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers): MerkleTree<RelayData> | null {
    const { unfilledDeposits } = this._loadData();
    // TODO: Use `bundleBlockNumbers` to decide how to filter which blocks to keep in `unfilledDeposits`.

    if (unfilledDeposits.length === 0) return null;
    const slowRelayLeaves: RelayData[] = unfilledDeposits.map(
      (deposit: UnfilledDeposit): RelayData => ({
        depositor: deposit.deposit.depositor,
        recipient: deposit.deposit.recipient,
        destinationToken: deposit.deposit.depositor,
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

  buildPoolRebalanceRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    const { fillsToRefund, deposits, slowFills } = this._loadData();

    const runningBalances: RunningBalances = {};
    const realizedLpFees: RunningBalances = {}; // Realized LP fees dictionary has same shape as runningBalances.

    // 1. For each FilledRelay group, identified by { repaymentChainId, L1TokenAddress }, initiate a "running balance"
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

      // 3. Map each deposit event to its L1 token and origin chain ID and subtract deposited amounts from running
      // balances.
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

      // 4. Map all slow fills to an L1 token using its destination chain ID and destination token.
      let filteredSlowFills = slowFills.filter(
        // First filter out all repeat slow fills. This would be all slow fills with `fillAmount == 0` and that have a
        // matching slow fill.
        (slowFill: Fill) =>
          slowFill.fillAmount.gt(toBN(0)) ||
          !slowFills.some(
            (otherSlowFill: Fill) =>
              otherSlowFill.originChainId === slowFill.originChainId && otherSlowFill.depositId === slowFill.depositId
          )
      );
    }

    console.log(runningBalances, realizedLpFees);

    // For each destination chain ID key in unfilledDeposits
    //     Group by L1 token and for each L1 token:
    //         Add unfilledAmount to netSendAmount for L1 token
    //         Add realized LP fee to bundleLpFee for L1 token
    //         Figure out how RunningBalances works
    // For each repayment chain ID key in fillsToRefund
    //     Group by L1 token and for each L1 token:
    //         Add fillAmount to netSendAmount for L1 token
    //         Add realized LP fee to bundleLpFee for L1 token
    //         Figure out how RunningBalances works
    // Join repayment chain ID and destination chain ID data together
    // Make Leaf for destination chain ID. Optionally decide to split Leaf
    // data into smaller pieces and form sub groups with unique groupIndex's
    // Construct root
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
}
