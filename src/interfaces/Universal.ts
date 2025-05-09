import { SortableEvent } from ".";
import { BigNumber } from "../utils";

// Flattened HubPoolStore Event
export interface StoredCallDataEvent extends SortableEvent {
  target: string;
  data: string;
  nonce: BigNumber;
}

// Flattened Universal SpokePool Event
export interface RelayedCallDataEvent extends SortableEvent {
  nonce: BigNumber;
  caller: string;
}
