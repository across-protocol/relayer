import { Log } from ".";
import { BigNumber } from "../utils";

export interface StorageSlotVerifiedEventArgs {
  head: BigNumber;
  key: string; // bytes32
  value: string; // bytes32
  contractAddress: string;
}

// Event type for Sp1Helios used in v4 messaging
export type StorageSlotVerifiedEvent = Log & { args: StorageSlotVerifiedEventArgs };
