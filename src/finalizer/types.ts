import { Signer } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { Multicall2Call } from "../common";
import { winston } from "../utils";

/**
 * A cross-chain transfer is a transfer of tokens from one chain to another. This can be a withdrawal from L2 to L1,
 * a deposit from L1 to L2, or a miscellaneous transaction to facilitate the two.
 *
 * Note: This is a union type. All cross-chain transfers will have the properties `originationChainId`, `destinationChainId`,
 *       `l1TokenSymbol`, and `amount`. The other properties will only be present if the transfer is of that type.
 */
export type CrossChainTransfer = {
  originationChainId: number;
  destinationChainId: number;
  l1TokenSymbol: string;
  amount: string;
} & (
  | {
      type: "withdrawal" | "deposit";
    }
  | {
      type: "misc";
      miscReason: string;
    }
);

export type FinalizerPromise = { callData: Multicall2Call[]; crossChainTransfers: CrossChainTransfer[] };

export interface ChainFinalizer {
  (
    logger: winston.Logger,
    signer: Signer,
    hubPoolClient: HubPoolClient,
    spokePoolClient: SpokePoolClient,
    firstBlockToFinalize: number
  ): Promise<FinalizerPromise>;
}
