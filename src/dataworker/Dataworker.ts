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
    // TODO: Add logs

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
        const depositsForDestinationChain = originClient.getDepositsForDestinationChain(destinationChainId);
        const unfilledDepositsForDestinationChain = depositsForDestinationChain.map((deposit) => {
          return { data: deposit, unfilledAmount: destinationClient.getValidUnfilledAmountForDeposit(deposit) };
        });

        // Remove any deposits that have no unfilled amount (i.e that have an unfilled amount of 0) and append the
        // remaining deposits to the unfilledDeposits array.
        assign(
          unfilledDeposits,
          [destinationChainId],
          [...unfilledDepositsForDestinationChain.filter((deposit) => deposit.unfilledAmount.gt(0))]
        );
        // unfilledDeposits[destinationChainId] = []
        // unfilledDeposits[destinationChainId].push(
        //   ...unfilledDepositsForDestinationChain.filter((deposit) => deposit.unfilledAmount.gt(0))
        // );

        // Grab all valid fills on the destination chain for the origin SpokePool.
        // const fillsOnDestinationChain = destinationClient.getFillsForDestinationChain(destinationChainId)
        // const validFillsOnDestinationChain = depositsForDestinationChain.map((deposit) => {
        //   return fillsOnDestinationChain.filter((fill) => destinationClient.validateFillForDeposit(fill, deposit))
        // })
        // for (const fill of validFillsOnDestinationChain) {
        //   fillsToRefund[fill.repaymentChainId][fill.refundAddress].push(fill)

        // }
      }
    }

    return {
      fillsToRefund,
      unfilledDeposits,
    };
    // For each origin chain ID (linked to 1 SpokePoolClient):
    //     Check all other SpokePoolClient's:
    //         Store deposits that map to origin chain as "UnfilledDeposit". 
    //         Associate each UnfilledDeposit with fillAmountRemaining = depositAmount
    //     Grab all fills from SpokePoolClient
    //         Attempt to map fill to an UnfilledDeposit, and decrement fillAmountRemaining
    //         Save fill and key by repaymentChainId => refundAddress
    //     Save all UnfilledDeposits with fillAmountRemaining > 0 as slowRelayFulfillments
  }

  async buildSlowRelayRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    this._loadData();

    // Grab all slowRelayFulfillments
    // Order fills by fillAmountRemaining
    // Construct leaf for destination chain ID
    // Construct root
  }

  async buildRelayerRefundRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    this._loadData();

    // Grab allFills
    // For each refundAddress, grab fills
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
    //    Grab all slowRelayFulfillments
    //        Add remaining fill amount to netSendAmount for L1 token
    //    For each L1 token, construct leaf with netSendAmount, bundleLpFee and runningBalance for L1 token
    //        If there are too many L1 tokens for a single destination chain ID leaf,
    //        then split up the L1 tokens across multiple leaves and give each
    //        a unique groupIndex, starting at 0 and counting up by 1.
    // Construct root
  }
}
