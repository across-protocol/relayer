import { winston, assign, buildSlowRelayTree, MerkleTree } from "../utils";
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
    const unfilledDepositsForOriginChain: { [originChainIdPlusDepositId: string]: UnfilledDeposit } = {};
    const fillsToRefund: FillsToRefund = {};

    const allChainIds = Object.keys(this.spokePoolClients);
    this.logger.debug({ at: "Dataworker", message: `Loading deposit and fill data`, chainIds: allChainIds });
    for (const originChainId of allChainIds) {
      const originClient = this.spokePoolClients[originChainId];
      if (!originClient.isUpdated()) throw new Error(`origin spokepoolclient on chain ${originChainId} not updated`);

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      this.logger.debug({ at: "Dataworker", message: `Looking up data for origin spoke pool`, originChainId });
      for (const destinationChainId of Object.keys(this.spokePoolClients)) {
        if (originChainId === destinationChainId) continue;

        const destinationClient = this.spokePoolClients[destinationChainId];
        if (!destinationClient.isUpdated())
          throw new Error(`destination spokepoolclient with chain ID ${destinationChainId} not updated`);

        // For each fill within the block range, look up associated deposit.
        const fillsForOriginChain: Fill[] = destinationClient.getFillsForOriginChain(Number(originChainId))
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
            if (!fill.isSlowRelay) assign(fillsToRefund, [fill.repaymentChainId, fill.relayer], [fill]);
            // Save this deposit as an unfilled deposit and update its unfilled amount if this fill occurred later
            // than the last saved fill for this deposit.
            const fillUnfilledAmount = fill.amount.sub(fill.totalFilledAmount);
            const fillKey = `${originChainId}+${fill.depositId}`;
            const existingMatchedDepositForFill: UnfilledDeposit | undefined = unfilledDepositsForOriginChain[fillKey];
            if (!existingMatchedDepositForFill || existingMatchedDepositForFill.unfilledAmount.gt(fillUnfilledAmount)) {
              assign(unfilledDepositsForOriginChain, [fillKey], {
                deposit: matchedDeposit,
                unfilledAmount: fillUnfilledAmount,
              });
            }
          } else {
            this.logger.debug({
              at: "Dataworker",
              message: `Could not find deposit for fill on origin client`,
              fill,
            });
          }
        })
      }
    }

    // Remove deposits that have been fully filled from unfilled deposit array
    return {
      fillsToRefund,
      unfilledDeposits: Object.values(unfilledDepositsForOriginChain)
        .flat()
        .filter((unfilledDeposit) => unfilledDeposit.unfilledAmount.gt(0)),
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
        )

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

  async buildRelayerRefundRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    this._loadData();

    // For each repayment chain ID key in fillsToRefund
    //     Group by refundAddress, and for each refund address
    //         Order fills by fillAmount
    //     Make Leaf for repayment chain ID
    // Construct root
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
