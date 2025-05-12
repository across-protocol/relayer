import { SortableEvent } from ".";
import { BigNumber } from "../utils";

// Event type for Sp1Helios used in v4 messaging (Flattened)
export interface StorageSlotVerifiedEvent extends SortableEvent {
  key: string; // bytes32 indexed (storage slot key)
  value: string; // bytes32 (value at storage slot key)
  head: BigNumber; // uint256 (beacon chain slot number)
  contractAddress: string; // address
}

// Flattened SP1Helios Event for HeadUpdate
export interface HeadUpdateEvent extends SortableEvent {
  slot: BigNumber; // uint256
  root: string; // bytes32
}
