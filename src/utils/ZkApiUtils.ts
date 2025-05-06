import { BigNumber, ethers } from ".";
import { ApiProofRequest, PROOF_OUTPUTS_ABI_TUPLE, ProofOutputs } from "../interfaces/ZkApi";

/**
 * Calculates the deterministic Proof ID based on the request parameters.
 * Matches the Rust implementation using RLP encoding and Keccak256.
 */
export function calculateProofId(request: ApiProofRequest): string {
  const encoded = ethers.utils.RLP.encode([
    request.src_chain_contract_address,
    request.src_chain_storage_slot,
    BigNumber.from(request.src_chain_block_number).toHexString(), // Ensure block number is hex encoded for RLP
    BigNumber.from(request.dst_chain_contract_from_head).toHexString(), // Ensure head is hex encoded for RLP
    request.dst_chain_contract_from_header,
  ]);
  return ethers.utils.keccak256(encoded);
}

/**
 * Decodes the ABI-encoded public_values string from the ZK Proof API into a structured ProofOutputs object.
 * @param publicValuesBytes The ABI-encoded hex string (with or without 0x prefix) containing the proof outputs.
 * @returns The decoded ProofOutputs object.
 * @throws {Error} If the decoding fails (e.g., invalid format).
 */
export function decodeProofOutputs(publicValuesBytes: string): ProofOutputs {
  // Ensure 0x prefix for decoder
  const prefixedBytes = publicValuesBytes.startsWith("0x") ? publicValuesBytes : "0x" + publicValuesBytes;
  const decodedResult = ethers.utils.defaultAbiCoder.decode([PROOF_OUTPUTS_ABI_TUPLE], prefixedBytes)[0];

  // Map the decoded array elements to the ProofOutputs type properties
  // @dev Notice, if `decodedResult` is not what we expect, this will implicitly throw an error.
  return {
    executionStateRoot: decodedResult[0],
    newHeader: decodedResult[1],
    nextSyncCommitteeHash: decodedResult[2],
    newHead: decodedResult[3], // Already a BigNumber from decoder
    prevHeader: decodedResult[4],
    prevHead: decodedResult[5], // Already a BigNumber from decoder
    syncCommitteeHash: decodedResult[6],
    startSyncCommitteeHash: decodedResult[7],
    slots: decodedResult[8].map((slot: any[]) => ({
      key: slot[0],
      value: slot[1],
      contractAddress: slot[2],
    })),
  };
}
