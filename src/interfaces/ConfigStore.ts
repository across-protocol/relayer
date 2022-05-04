import { BigNumber } from "../utils";

export interface L1TokenTransferThreshold {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transferThreshold: BigNumber;
  l1Token: string;
}
