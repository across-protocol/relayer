import { Log } from ".";
import { BigNumber } from "../utils";

export interface StoredCallDataEventArgs {
  target: string;
  data: string;
  nonce: BigNumber;
}

export interface RelayedCallDataEventArgs {
  nonce: BigNumber;
  caller: string;
}

// Event types for HubPoolStore and Universal_SpokePool used in v4 messaging
export type StoredCallDataEvent = Log & { args: StoredCallDataEventArgs };
export type RelayedCallDataEvent = Log & { args: RelayedCallDataEventArgs };
