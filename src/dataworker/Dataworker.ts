import { winston, assign } from "../utils";
import { buildSlowRelayTree, RelayData } from "@across-protocol/contracts-v2/dist/test-utils";
import { SpokePoolClient, HubPoolClient, MultiCallBundler } from "../clients";
import { UnfilledDeposits, FillsToRefund, UnfilledDeposit, Fill, Deposit } from "../interfaces/SpokePool";
import { BundleEvaluationBlockNumbers } from "../interfaces/HubPool";
import { MerkleTree } from "@across-protocol/contracts-v2/dist/utils/MerkleTree";

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
  _loadData(): { unfilledDeposits: UnfilledDeposits; fillsToRefund: FillsToRefund } {
    const unfilledDeposits: UnfilledDeposits = {};
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

        // Store deposits whose destination chain is the selected chain as unfilled deposits and set the initial fill
        // amount remaining equal to the full deposit amount minus any valid fill amounts.
        // Remove any deposits that have no unfilled amount (i.e that have an unfilled amount of 0) and append the
        // remaining deposits to the unfilledDeposits array.
        const depositsForDestinationChain: Deposit[] = originClient.getDepositsForDestinationChain(destinationChainId);
        this.logger.debug({
          at: "Dataworker",
          message: `Found ${depositsForDestinationChain.length} deposits for destination chain ${destinationChainId}`,
          originChainId,
          destinationChainId,
        });

        // For each deposit on the destination chain, fetch all valid fills associated with it and store it to a
        // valid fill array that this client can use to construct a list of relayer refunds. Additionally, if the
        // latest valid fill for the deposit did not completely fill it, then store the deposit as an "unfilled" deposit
        // that we'll want to include in a list of slow relays to execute.
        const validFillsOnDestinationChain: Fill[] = [];
        const unfilledDepositsForDestinationChain: UnfilledDeposit[] = [];
        depositsForDestinationChain.forEach((deposit) => {
          const { fills: validFillsForDeposit, unfilledAmount } = destinationClient.getValidFillsForDeposits(deposit);
          // There are no refunds to be sent for slow relays.
           validFillsOnDestinationChain.push(...validFillsForDeposit.filter((fill: Fill) => !fill.isSlowRelay));
          if (unfilledAmount.gt(0))
            unfilledDepositsForDestinationChain.push({
              deposit,
              unfilledAmount,
            });
        });

        if (unfilledDepositsForDestinationChain.length > 0)
          assign(unfilledDeposits, [destinationChainId], unfilledDepositsForDestinationChain);
        else
          this.logger.debug({
            at: "Dataworker",
            message: `All deposits are filled`,
            originChainId,
            destinationChainId,
          });

        this.logger.debug({
          at: "Dataworker",
          message: `Found ${validFillsOnDestinationChain.length} fills on destination ${destinationChainId} matching origin ${originChainId}`,
          originChainId,
          destinationChainId,
        });
        validFillsOnDestinationChain.forEach((fill) =>
          assign(fillsToRefund, [fill.repaymentChainId, fill.relayer], [fill])
        );
      }
    }

    return {
      fillsToRefund,
      unfilledDeposits,
    };
  }

  async buildSlowRelayRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers): Promise<MerkleTree<RelayData>> | null {
    const { unfilledDeposits } = this._loadData();
    // TODO: Use `bundleBlockNumbers` to decide how to filter which blocks to keep in `unfilledDeposits`.

    if (Object.keys(unfilledDeposits).length === 0) return null;

    // Key leaves temporarily by destination chain ID which we'll re-order later.
    const leavesByChainId: { [chainId: number]: RelayData[] } = {};

    for (const destinationChainId of Object.keys(unfilledDeposits)) {
      // We need to re-order leaves deterministically such that the same data returned by _loadData() always produces
      // the same merkle root. So we'll order the deposits for each chain ID by unfilled amount since this will order
      // leaves by largest token outflows from the SpokePool to fulfill slow relays. (Recall that slow relay leaf
      // executions send to the recipient the unfilled amount of their deposit, not just the deposit amount).
      unfilledDeposits[destinationChainId].sort(function (a: UnfilledDeposit, b: UnfilledDeposit) {
        return a.unfilledAmount.gt(b.unfilledAmount) ? -1 : 1;
      });

      // Associate relay data implied by unfilled deposit with destination chain ID.
      leavesByChainId[destinationChainId] = [];
      unfilledDeposits[destinationChainId].forEach((deposit) => {
        leavesByChainId[destinationChainId].push({
          depositor: deposit.deposit.depositor,
          recipient: deposit.deposit.recipient,
          destinationToken: deposit.deposit.depositor,
          amount: deposit.deposit.amount.toString(),
          originChainId: deposit.deposit.originChainId.toString(),
          destinationChainId: deposit.deposit.destinationChainId.toString(),
          realizedLpFeePct: deposit.deposit.realizedLpFeePct.toString(),
          relayerFeePct: deposit.deposit.relayerFeePct.toString(),
          depositId: deposit.deposit.depositId.toString(),
        });
      });
    }

    // Flatten leaves deterministically so that the same root is always produced from the same _loadData return value.
    // To do that we'll sort keys by chain ID and then concat sorted leaves.
    const leaves: RelayData[] = Object.keys(leavesByChainId)
      .sort(function (a, b) {
        return Number(b) - Number(a);
      })
      .reduce(function (prev: RelayData[], current: string) {
        return prev.concat(leavesByChainId[Number(current)]);
      }, []);

    return leaves.length > 0 ? await buildSlowRelayTree(leaves) : null;

    // TODO: Figure out how to store merkle trees. IPFS?
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

  async executeSlowRelayLeaves() {
    // TODO:
  }

  async executePoolRebalanceLeaves() {
    // TODO:
  }

  async executeRelayerRefundLeaves() {
    // TODO:
  }
}
