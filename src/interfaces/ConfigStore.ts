import { BigNumber } from "../utils";
import { SortableEvent } from "./Common";
export interface L1TokenTransferThreshold extends SortableEvent {
  transferThreshold: BigNumber;
  l1Token: string;
}

export interface L1TokenStartingRunningBalance extends SortableEvent {
  startingRunningBalance: { [chainId: number]: BigNumber };
  l1Token: string;
}

export interface TokenConfig extends SortableEvent {
  key: string;
  value: string;
}

export interface GlobalConfigUpdate extends SortableEvent {
  value: number;
}
