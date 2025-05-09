import { Signer } from "ethers";
import { AugmentedTransaction, HubPoolClient, SpokePoolClient } from "../clients";
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

export type FinalizerPromise = {
  callData: (Multicall2Call | AugmentedTransaction)[];
  crossChainMessages: CrossChainMessage[];
};

export interface ChainFinalizer {
  (
    logger: winston.Logger,
    signer: Signer,
    hubPoolClient: HubPoolClient,
    l2SpokePoolClient: SpokePoolClient,
    l1SpokePoolClient: SpokePoolClient,
    l1ToL2AddressesToFinalize: string[]
  ): Promise<FinalizerPromise>;
}

/**
 * Type guard to check if a transaction object is an AugmentedTransaction.
 * @param txn The transaction object to check.
 * @returns True if the object is an AugmentedTransaction, false otherwise.
 */
export function isAugmentedTransaction(txn: Multicall2Call | AugmentedTransaction): txn is AugmentedTransaction {
  // Check for the presence of the 'contract' property, unique to AugmentedTransaction
  return txn != null && typeof txn === "object" && "contract" in txn;
}
