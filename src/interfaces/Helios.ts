import { SortableEvent } from ".";
import { BigNumber } from "../utils";

// Event type for Sp1Helios used in v4 messaging (Flattened)
export interface StorageSlotVerifiedEvent extends SortableEvent {
  key: string; // bytes32 indexed key
  value: string; // bytes32 value
  head: BigNumber; // uint256 indexed head (beacon chain slot number)
  // contractAddress will also be present due to spreadEventWithBlockNumber
}

// Flattened SP1Helios Event for HeadUpdate
export interface HeadUpdateEvent extends SortableEvent {
  slot: BigNumber; // uint256 indexed slot
  root: string; // bytes32 indexed root
  // contractAddress will also be present due to spreadEventWithBlockNumber
}
