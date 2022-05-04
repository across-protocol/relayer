import { BigNumber } from "../utils";
import { SortableEvent } from "./Common";
export interface L1TokenTransferThreshold extends SortableEvent {
  transferThreshold: BigNumber;
  l1Token: string;
}

export interface TokenConfig extends SortableEvent {
  key: string;
  value: string;
}

export interface RefundsPerRelayerRefundLeaf extends SortableEvent {
  value: number;
}

export interface L1TokensPerPoolRebalanceLeaf extends SortableEvent {
  value: number;
}
