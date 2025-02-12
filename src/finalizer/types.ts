import { Signer } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { Multicall2Call, winston } from "../utils";

/**
 * A cross-chain message is a message sent from one chain to another. This can be a token withdrawal from L2 to L1,
 * a token deposit from L1 to L2, or a miscellaneous transaction to facilitate the two.
 *
 * Note: This is a union type. All cross-chain transfers will have the properties `originationChainId` and `destinationChainId`.
 *       The other properties will only be present if the transfer is of that type.
 */
export type CrossChainMessage = {
  originationChainId: number;
  destinationChainId: number;
} & (
  | {
      type: "withdrawal" | "deposit";
      l1TokenSymbol: string;
      amount: string;
    }
  | {
      type: "misc";
      miscReason: string;
      // Note: Properties `l1TokenSymbol` and `amount` are optional for type "misc" b/c not all misc transactions will have
      // these properties, e.g. a call to `relayMessage` of an Adapter contract.
      l1TokenSymbol?: string;
      amount?: string;
    }
);

export type FinalizerPromise = { callData: Multicall2Call[]; crossChainMessages: CrossChainMessage[] };

export interface ChainFinalizer {
  (
    logger: winston.Logger,
    signer: Signer,
    hubPoolClient: HubPoolClient,
    l2SpokePoolClient: SpokePoolClient,
    // The following types are only used in L1->L2 finalizers currently and can be omitted in L2->L1 finalizers.
    l1SpokePoolClient: SpokePoolClient,
    l1ToL2AddressesToFinalize: string[]
  ): Promise<FinalizerPromise>;
}
