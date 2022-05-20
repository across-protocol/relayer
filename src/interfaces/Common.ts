import { BigNumber, MerkleTree } from "../utils";

export interface SortableEvent {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
}

export interface BigNumberForToken {
  [l1TokenAddress: string]: BigNumber;
}

export interface TreeData<T> {
  tree: MerkleTree<T>;
  leaves: T[];
}
