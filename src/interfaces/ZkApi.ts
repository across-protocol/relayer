import { BigNumber } from "../utils";
import { enums, Infer, object, optional, string } from "superstruct";

// --- API Interaction Types ---
export interface ApiProofRequest {
  src_chain_contract_address: string;
  src_chain_storage_slots: string[];
  src_chain_block_number: number; // u64 on Rust API side
  dst_chain_contract_from_head: number; // u64 on Rust API side
  dst_chain_contract_from_header: string;
}

export const ProofStatusSS = enums(["pending", "success", "errored"]);
export type ProofStatus = Infer<typeof ProofStatusSS>;

export const VkeyResponseSS = object({
  vkey: string(),
});
export type VkeyResponse = Infer<typeof VkeyResponseSS>;

export const SP1HeliosProofDataSS = object({
  proof: string(),
  public_values: string(),
});
export type SP1HeliosProofData = Infer<typeof SP1HeliosProofDataSS>;

export const ProofStateResponseSS = object({
  proof_id: string(),
  status: ProofStatusSS,
  update_calldata: optional(SP1HeliosProofDataSS),
  error_message: optional(string()),
});
export type ProofStateResponse = Infer<typeof ProofStateResponseSS>;

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
