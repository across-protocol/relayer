import { SortableEvent } from ".";
import { BigNumber } from "../utils";

export interface TokenTransfer extends SortableEvent {
  value: BigNumber;
  from: string;
  to: string;
}

export interface TransfersByTokens {
  [token: string]: {
    incoming: TokenTransfer[];
    outgoing: TokenTransfer[];
  };
}

export interface TransfersByChain {
  [chainId: number]: TransfersByTokens;
}
