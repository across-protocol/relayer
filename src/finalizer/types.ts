import { BigNumber, Signer } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { Multicall2Call } from "../common";
import { winston } from "../utils";
import { OnChainMessageStatus } from "@consensys/linea-sdk";

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
    spokePoolClient: SpokePoolClient,
    l1ToL2AddressesToFinalize: string[]
  ): Promise<FinalizerPromise>;
}

export interface EnrichedLineaSentMessageEvent {
  messageSender: string;
  destination: string;
  fee: BigNumber;
  value: BigNumber;
  messageNonce: BigNumber;
  calldata: string;
  messageHash: string;
  txHash: string;
  logIndex: number;
  status: OnChainMessageStatus;
}
