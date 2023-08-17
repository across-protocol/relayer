import { Wallet } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { Multicall2Call } from "../common";
import { winston } from "../utils";

export type Withdrawal = {
  l2ChainId: number;
  l1TokenSymbol: string;
  amount: string;
  type: "proof" | "withdrawal";
};

export type FinalizerPromise = { callData: Multicall2Call[]; withdrawals: Withdrawal[] };

export interface ChainFinalizer {
  (
    logger: winston.Logger,
    signer: Wallet,
    hubPoolClient: HubPoolClient,
    spokePoolClient: SpokePoolClient,
    firstBlockToFinalize: number
  ): Promise<FinalizerPromise>;
}
