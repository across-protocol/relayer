import {
  winston,
  assign,
  buildSlowRelayTree,
  MerkleTree,
  toBN,
  RelayerRefundLeaf,
  BigNumber,
  buildRelayerRefundTree,
  toBNWei,
} from "../utils";
import { SpokePoolClient, HubPoolClient, MultiCallBundler } from "../clients";
import { FillsToRefund, RelayData, UnfilledDeposit, Deposit, Fill } from "../interfaces/SpokePool";
import { BundleEvaluationBlockNumbers } from "../interfaces/HubPool";

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly multiCallBundler: MultiCallBundler | any
  ) {}

  // Common data re-formatting logic shared across all data worker public functions.
  _loadData(/* bundleBlockNumbers: BundleEvaluationBlockNumbers */): {
    unfilledDeposits: UnfilledDeposit[];
    fillsToRefund: FillsToRefund;
  } {
    if (!this.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);

    const unfilledDepositsForOriginChain: { [originChainIdPlusDepositId: string]: UnfilledDeposit[] } = {};
    const fillsToRefund: FillsToRefund = {};

    const allChainIds = Object.keys(this.spokePoolClients);
    this.logger.debug({ at: "Dataworker", message: `Loading deposit and fill data`, chainIds: allChainIds });
    for (const originChainId of allChainIds) {
      const originClient = this.spokePoolClients[originChainId];
      if (!originClient.isUpdated) throw new Error(`origin SpokePoolClient on chain ${originChainId} not updated`);

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      this.logger.debug({ at: "Dataworker", message: `Looking up data for origin spoke pool`, originChainId });
      for (const destinationChainId of Object.keys(this.spokePoolClients)) {
        if (originChainId === destinationChainId) continue;

        const destinationClient = this.spokePoolClients[destinationChainId];
        if (!destinationClient.isUpdated)
          throw new Error(`destination SpokePoolClient with chain ID ${destinationChainId} not updated`);

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
            if (!fill.isSlowRelay) assign(fillsToRefund, [fill.repaymentChainId, fill.destinationToken], [fill]);
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
    return {
      fillsToRefund,
      unfilledDeposits,
    };
  }

  async buildSlowRelayRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers): Promise<MerkleTree<RelayData>> | null {
    const { unfilledDeposits } = this._loadData();
    // TODO: Use `bundleBlockNumbers` to decide how to filter which blocks to keep in `unfilledDeposits`.

    if (unfilledDeposits.length === 0) return null;
    const leaves: RelayData[] = unfilledDeposits.map(
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
    const sortedLeaves = leaves.sort((relayA, relayB) => {
      // Note: Smaller ID numbers will come first
      if (relayA.originChainId === relayB.originChainId) return relayA.depositId - relayB.depositId;
      else return relayA.originChainId - relayB.originChainId;
    });

    return sortedLeaves.length > 0 ? await buildSlowRelayTree(sortedLeaves) : null;
  }

  async publishRoots(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    const slowRelayRoot = await this.buildSlowRelayRoot(bundleBlockNumbers);

    // TODO: Store root to be consumed by manual leaf executors and verifiers. Can also be used to track lifecyle
    // of roots.
  }

  async buildRelayerRefundRoot(
    bundleBlockNumbers: BundleEvaluationBlockNumbers
  ): Promise<MerkleTree<RelayerRefundLeaf>> | null {
    const { fillsToRefund } = this._loadData();
    if (Object.keys(fillsToRefund).length === 0) return null;

    const leaves: RelayerRefundLeaf[] = [];
    Object.keys(fillsToRefund).forEach((repaymentChainId: string) => {
      Object.keys(fillsToRefund[repaymentChainId]).forEach((l2TokenAddress: string) => {
        // Sum refunds for all refund addresses for each L2 token.
        const refunds: { [refundAddress: string]: BigNumber } = {};
        fillsToRefund[repaymentChainId][l2TokenAddress].forEach((fill: Fill) => {
          const existingFillAmountForRelayer = refunds[fill.relayer] ? refunds[fill.relayer] : toBN(0);
          const currentRefundAmount = fill.fillAmount.mul(toBNWei(1).sub(fill.realizedLpFeePct)).div(toBNWei(1));
          refunds[fill.relayer] = existingFillAmountForRelayer.add(currentRefundAmount);
        });
        // Sort leaves deterministically so that the same root is always produced from the same _loadData return value.
        // Sort by refund amount (descending) and then address (ascending).
        const sortedRefundAddresses = Object.keys(refunds).sort((addressA, addressB) => {
          if (refunds[addressA].gt(refunds[addressB])) return -1;
          if (refunds[addressA].lt(refunds[addressB])) return 1;
          return addressA.localeCompare(addressB);
        });

        // Create leaf for repayment chain ID and L2 token address combination.
        leaves.push({
          leafId: toBN(0), // Will be updated before inserting into tree after we sort all leaves.
          chainId: BigNumber.from(repaymentChainId),
          amountToReturn: toBN(0),
          l2TokenAddress: l2TokenAddress,
          refundAddresses: sortedRefundAddresses,
          refundAmounts: sortedRefundAddresses.map((address) => refunds[address]),
          // TODO: Make sure refund arrays length are capped and their contents are split in the worst case
        });
      });
    });

    // Sort leaves by chain ID and then L2 token address in ascending order.
    if (leaves.length === 0) return null;
    leaves.sort((leafA, leafB) => {
      if (!leafA.chainId.eq(leafB.chainId)) {
        return leafA.chainId.sub(leafB.chainId).toNumber();
      } else if (leafA.l2TokenAddress.localeCompare(leafB.l2TokenAddress) !== 0) {
        return leafA.l2TokenAddress.localeCompare(leafB.l2TokenAddress);
      } else throw new Error("TODO: Implement tertiary sorting of leaves");
    });
    const sortedLeaves = leaves.map((leaf: RelayerRefundLeaf, i: number) => {
      return { ...leaf, leafId: toBN(i) };
    });

    return await buildRelayerRefundTree(sortedLeaves);
  }

  async buildPoolRebalanceRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    this._loadData();

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
