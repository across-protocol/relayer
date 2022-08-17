import { BigNumber } from "../utils";

export interface OutstandingTransfers {
  [address: string]: {
    [l1Token: string]: {
      totalAmount: BigNumber;
      depositTxHashes: string[];
    };
  };
}
