import { Signer } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { Multicall2Call } from "../common";
import { winston } from "../utils";

export type CrossChainTransfer = {
  originationChainId: number;
  destinationChainId: number;
  l1TokenSymbol: string;
  amount: string;
  type: "misc" | "withdrawal" | "deposit";
};

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
