import { BigNumber, winston, buildFillRelayProps } from "./utils";
import { SpokePoolEventClient } from "./SpokePoolEventClient";
import { HubPoolEventClient } from "./HubPoolEventClient";
import { MulticallBundler } from "./MulticallBundler";
import { Deposit } from "./interfaces/SpokePool";
import { BundleEvaluationBlockNumbers } from "./interfaces/HubPool";

// @notice Constructs roots to submit to HubPool on L1
export class Dataworker {
  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolEventClients: { [chainId: number]: SpokePoolEventClient },
    readonly hubPoolClient: HubPoolEventClient,
    readonly multicallBundler: MulticallBundler | any
  ) {}

  async update() {
    // Grab all deposits from SpokePoolEventClient
    // Map deposits to their destination chain IDs
    // Grab all fills from SpokePoolEventClient
    // Filter out invalid fills for deposits
    // Group remaining fills by destination chain ID
  }

  async buildSlowRelayRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    // Filter out fills that fully fill a deposit. Can check against the list of deposits
    //     linked to this destination chain ID.
    // Order fills by remaining fill size
    // Construct leaf for destination chain ID
    // Construct root
  }

  async buildRelayerRefundRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    // Group by refund address
    // Order fills by total size
    // Construct leaf for destination chain ID
    // Construct root
  }

  async buildPoolRebalanceRoot(bundleBlockNumbers: BundleEvaluationBlockNumbers) {
    // For each destination chain ID:
    // Group fills by L1 token
    // For each L1 token:
    // Sum total relay refund amount ==> netSendAmount
    // Sum total slow relay amount and add to netSendAmount
    // Sum total realized LP fee % ==> bundleLpFee
    // Construct leaves for destination chain ID with fills grouped by L1 token
    // If there are too many L1 tokens for a single destination chain ID leaf,
    //     then split up the L1 tokens across multiple leaves and give each
    //     a unique groupIndex, starting at 0 and counting up by 1.
    // Construct root
  }
}
