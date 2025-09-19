import axios, { AxiosResponse } from "axios";
import { backoffWithJitter, BigNumber, ethers } from ".";
import {
  ApiProofRequest,
  PROOF_OUTPUTS_ABI_TUPLE,
  ProofOutputs,
  ProofStateResponse,
  VkeyResponse,
} from "../interfaces/ZkApi";
import axiosRetry, { isNetworkOrIdempotentRequestError } from "axios-retry";

/**
 * Calculates the deterministic Proof ID based on the request parameters.
 * Matches the Rust implementation using RLP encoding and Keccak256.
 */
export function calculateProofId(request: ApiProofRequest): string {
  // RLP spec: integer values should be minimal big-endian; zero is empty string
  const blockNumberHex = BigNumber.from(request.src_chain_block_number).isZero()
    ? "0x"
    : BigNumber.from(request.src_chain_block_number).toHexString();
  const headHex = BigNumber.from(request.dst_chain_contract_from_head).isZero()
    ? "0x"
    : BigNumber.from(request.dst_chain_contract_from_head).toHexString();
  const encoded = ethers.utils.RLP.encode([
    request.src_chain_contract_address,
    request.src_chain_storage_slots,
    blockNumberHex,
    headHex,
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

export async function getVkeyWithRetries(url: string): Promise<AxiosResponse<VkeyResponse>> {
  const apiClient = axios.create();
  axiosRetry(apiClient, {
    retries: 3,
    retryDelay: (retry) => backoffWithJitter(retry),
    retryCondition: (err) => isNetworkOrIdempotentRequestError(err) || err.response?.status === 409,
  });
  return apiClient.get<VkeyResponse>(url);
}

export async function getProofStateWithRetries(url: string): Promise<ProofStateResponse> {
  const apiClient = axios.create();
  axiosRetry(apiClient, {
    retries: 3,
    retryDelay: (retry) => backoffWithJitter(retry),
    retryCondition: (err) => isNetworkOrIdempotentRequestError(err) || err.response?.status === 409,
  });
  const response = await apiClient.get<ProofStateResponse>(url);
  return response.data;
}
