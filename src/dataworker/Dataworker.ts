import { BigNumber, winston, buildFillRelayProps, assign } from "../utils";
import { SpokePoolClient, HubPoolClient, RateModelClient, MultiCallBundler } from "../clients";
import { Deposit, Fill } from "../interfaces/SpokePool";
import { BundleEvaluationBlockNumbers } from "../interfaces/HubPool";

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
type UnfilledDeposit = {
  data: Deposit;
  unfilledAmount: BigNumber;
}
type UnfilledDeposits = { [destinationChainId: number]: UnfilledDeposit[] }
type FillsToRefund = { [repaymentChainId: number]: { [refundAddress: string]: Fill[] } }

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
      if (!originClient.isUpdated()) throw new Error(`origin spokepoolclient with chain ID ${originChainId} not updated`);

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      for (const destinationChainId of Object.keys(this.spokePoolClients)) {
        if (originChainId === destinationChainId) continue;

        const destinationClient = this.spokePoolClients[destinationChainId];
        if (!destinationClient.isUpdated()) throw new Error(`destination spokepoolclient with chain ID ${destinationChainId} not updated`);
  
        // Store deposits whose destination chain is the selected chain as unfilled deposits and set the initial fill
        // amount remaining equal to the full deposit amount minus any valid fill amounts.
        // Remove any deposits that have no unfilled amount (i.e that have an unfilled amount of 0) and append the
        // remaining deposits to the unfilledDeposits array.
        const depositsForDestinationChain = originClient.getDepositsForDestinationChain(destinationChainId);
        const unfilledDepositsForDestinationChain = depositsForDestinationChain
          .map((deposit) => {
            return { data: deposit, unfilledAmount: destinationClient.getValidUnfilledAmountForDeposit(deposit) };
          })
          .filter((deposit) => deposit.unfilledAmount.gt(0));

        if (unfilledDepositsForDestinationChain.length > 0) {
          assign(unfilledDeposits, [destinationChainId], unfilledDepositsForDestinationChain);
        }

        // Grab all valid fills submitted to the destination spoke pool.
        const fillsOnDestinationChain = destinationClient.getFills()
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

    // Grab all unfilledDeposits
    // Order by fillAmountRemaining
    // Construct leaf for destination chain ID
    // Construct root
  }

  async buildRelayerRefundRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    this._loadData();

    // Grab all fillsToRefund
    // For each refundAddress
    //     Order fills by fillAmount
    //     Construct leaf for destination chain ID
    //     Construct root
  }

  async buildPoolRebalanceRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    this._loadData();

    // For each destination chain ID (linked to 1 SpokePoolClient):
    //    Grab all fills from SpokePoolClient
    //        Add fill amount to netSendAmount for L1 token associated with L2 token in fill
    //        Add realized LP fee to bundleLpFee for L1 token
    //    Grab all unfilledDeposits
    //        Add remaining fill amount to netSendAmount for L1 token
    //    For each L1 token, construct leaf with netSendAmount, bundleLpFee and runningBalance for L1 token
    //        If there are too many L1 tokens for a single destination chain ID leaf,
    //        then split up the L1 tokens across multiple leaves and give each
    //        a unique groupIndex, starting at 0 and counting up by 1.
    // Construct root
  }
}
