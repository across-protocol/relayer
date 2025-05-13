import { SortableEvent } from ".";
import { BigNumber } from "../utils";

// Event type for Sp1Helios used in v4 messaging (Flattened)
export interface StorageSlotVerifiedEvent extends SortableEvent {
  head: BigNumber;
  key: string; // bytes32
  value: string; // bytes32
  contractAddress: string;
}
