import { BigNumber } from "ethers";
import { SortableEvent } from "../../interfaces";

export interface DepositEvent extends SortableEvent {
  amount: BigNumber;
}

export interface Events {
  [address: string]: {
    [l1Token: string]: { [l2Token: string]: DepositEvent[] };
  };
}

export interface OutstandingTransfers {
  [address: string]: {
    [l1Token: string]: {
      [l2Token: string]: {
        totalAmount: BigNumber;
        depositTxHashes: string[];
      };
    };
  };
}

// TODO: make these generic arguments to BaseAdapter.
export type SupportedL1Token = string;
export type SupportedTokenSymbol = string;
