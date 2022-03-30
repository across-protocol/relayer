import { BigNumber, winston, assign } from "../utils";
import { SpokePoolClient, HubPoolClient, MultiCallBundler } from "../clients";
import { Deposit, Fill } from "../interfaces/SpokePool";
import { BundleEvaluationBlockNumbers } from "../interfaces/HubPool";

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
type UnfilledDeposit = {
  data: Deposit;
  unfilledAmount: BigNumber;
};
type UnfilledDeposits = { [destinationChainId: number]: UnfilledDeposit[] };
type FillsToRefund = { [repaymentChainId: number]: { [refundAddress: string]: Fill[] } };

export class Dataworker {
  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly multiCallBundler: MultiCallBundler | any
  ) {}

  // Common data re-formatting logic shared across all data worker public functions.
  _loadData(): { unfilledDeposits: UnfilledDeposits; fillsToRefund: FillsToRefund } {
    // For each origin chain spoke pool client:
    //     For all destination spoke pool client's:
    //         Store deposits that are sent from origin chain to destination chain as an UnfilledDeposit
    //             Associate this UnfilledDeposit with the destination chain and set fillAmountRemaining
    //         Grab all fills on destination client
    //             Attempt to map fill to an UnfilledDeposit sent from the origin chain
    //             If a match is found, save fill and key by repaymentChainId => refundAddress

    const unfilledDeposits: UnfilledDeposits = {};
    const fillsToRefund: FillsToRefund = {};

    for (const originChainId of Object.keys(this.spokePoolClients)) {
      const originClient = this.spokePoolClients[originChainId];
      if (!originClient.isUpdated())
        throw new Error(`origin spokepoolclient with chain ID ${originChainId} not updated`);

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      this.logger.debug({ at: "Dataworker", message: `Looking up data for origin spoke pool`, originChainId });
      for (const destinationChainId of Object.keys(this.spokePoolClients)) {
        if (originChainId === destinationChainId) continue;

        const destinationClient = this.spokePoolClients[destinationChainId];
        if (!destinationClient.isUpdated())
          throw new Error(`destination spokepoolclient with chain ID ${destinationChainId} not updated`);

        // Store deposits whose destination chain is the selected chain as unfilled deposits and set the initial fill
        // amount remaining equal to the full deposit amount minus any valid fill amounts.
        // Remove any deposits that have no unfilled amount (i.e that have an unfilled amount of 0) and append the
        // remaining deposits to the unfilledDeposits array.
        const depositsForDestinationChain = originClient.getDepositsForDestinationChain(destinationChainId);
        this.logger.debug({
          at: "Dataworker",
          message: `Found ${depositsForDestinationChain.length} deposits for destination chain ${destinationChainId}`,
          originChainId,
          destinationChainId,
        });

        const unfilledDepositsForDestinationChain = depositsForDestinationChain
          .map((deposit) => {
            return { data: deposit, unfilledAmount: destinationClient.getValidUnfilledAmountForDeposit(deposit) };
          })
          .filter((deposit) => deposit.unfilledAmount.gt(0));

        if (unfilledDepositsForDestinationChain.length > 0) {
          assign(unfilledDeposits, [destinationChainId], unfilledDepositsForDestinationChain);
        } else {
          this.logger.debug({
            at: "Dataworker",
            message: `All deposits are filled`,
            originChainId,
            destinationChainId,
          });
        }

        // Grab all valid fills submitted to the destination spoke pool.
        const fillsOnDestinationChain = destinationClient.getFills();
        const validFillsOnDestinationChain = fillsOnDestinationChain.filter((fill) => {
          // For each fill, see if we can find a deposit sent from the origin client that matches it.
          for (const deposit of depositsForDestinationChain) {
            // @dev: It doesn't matter which client we call validateFillForDeposit() on as the logic is
            // chain agnostic.
            if (destinationClient.validateFillForDeposit(fill, deposit)) return true;
            else continue;
          }

          // No deposit matched, this fill is invalid.
          return false;
        });
        this.logger.debug({
          at: "Dataworker",
          message: `Found ${validFillsOnDestinationChain.length} fills on destination ${destinationChainId} matching origin ${originChainId}`,
          originChainId,
          destinationChainId,
        });

        for (const fill of validFillsOnDestinationChain) {
          assign(fillsToRefund, [fill.repaymentChainId, fill.relayer], [fill]);
        }
      }
    }

    return {
      fillsToRefund,
      unfilledDeposits,
    };
  }

  async buildSlowRelayRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    this._loadData();

    // For each destination chain ID key in unfilledDeposits
    //     Order by fillAmountRemaining
    //     Make Leaf for fill
    // Construct root
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
}
