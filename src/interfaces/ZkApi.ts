import { BigNumber } from "../utils";

// --- API Interaction Types ---
export interface ApiProofRequest {
  src_chain_contract_address: string;
  src_chain_storage_slot: string;
  src_chain_block_number: number; // u64 on Rust API side
  dst_chain_contract_from_head: number; // u64 on Rust API side
  dst_chain_contract_from_header: string;
}

export type ProofStatus = "pending" | "success" | "errored";

export interface SP1HeliosProofData {
  proof: string;
  public_values: string;
}

export interface ProofStateResponse {
  proof_id: string;
  status: ProofStatus;
  update_calldata?: SP1HeliosProofData; // Present only if status is "success"
  error_message?: string; // Present only if status is "errored"
}

// ABI for `public_values` returned from ZK API as part of `SP1HeliosProofData`
export const PROOF_OUTPUTS_ABI_TUPLE = `tuple(
      bytes32 executionStateRoot,
      bytes32 newHeader,
      bytes32 nextSyncCommitteeHash,
      uint256 newHead,
      bytes32 prevHeader,
      uint256 prevHead,
      bytes32 syncCommitteeHash,
      bytes32 startSyncCommitteeHash,
      tuple(bytes32 key, bytes32 value, address contractAddress)[] slots
  )`;

export type ProofOutputs = {
  executionStateRoot: string;
  newHeader: string;
  nextSyncCommitteeHash: string;
  newHead: BigNumber;
  prevHeader: string;
  prevHead: BigNumber;
  syncCommitteeHash: string;
  startSyncCommitteeHash: string;
  slots: { key: string; value: string; contractAddress: string }[];
};
