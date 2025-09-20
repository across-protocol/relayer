import axios from "axios";
import { backoffWithJitter, BigNumber, ethers } from ".";
import {
  ApiProofRequest,
  PROOF_OUTPUTS_ABI_TUPLE,
  ProofOutputs,
  ProofStateResponse,
  ProofStateResponseSS,
  VkeyResponse,
  VkeyResponseSS,
} from "../interfaces/ZkApi";
import { create } from "superstruct";

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

export async function getProofStateWithRetries(
  apiBaseUrl: string,
  proofId: string,
  maxAttempts = 3
): Promise<ProofStateResponse | 404> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await axios.get(`${apiBaseUrl}/v1/api/proofs/${proofId}`);
      const proofState: ProofStateResponse = create(response.data, ProofStateResponseSS);
      return proofState;
    } catch (e: any) {
      // 404 is a valid/expected response: proof not yet created
      if (axios.isAxiosError(e) && e.response?.status === 404) {
        return 404;
      }

      attempt++;
      if (attempt >= maxAttempts) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffWithJitter(attempt)));
      // todo: consider adding a logger log here .onRetry with `datadog = true` to monitor the error rates
    }
  }
}

export async function requestProofWithRetries(
  apiBaseUrl: string,
  request: ApiProofRequest,
  maxAttempts = 3
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await axios.post(`${apiBaseUrl}/v1/api/proofs`, request);
      return;
    } catch (e: any) {
      attempt++;
      if (attempt >= maxAttempts) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffWithJitter(attempt)));
      // todo: consider adding a logger log here .onRetry with `datadog = true` to monitor the error rates
    }
  }
}

export async function getVkeyWithRetries(apiBaseUrl: string, maxAttempts = 3): Promise<VkeyResponse> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await axios.get(`${apiBaseUrl}/v1/api/vkey`);
      const vkeyResponse: VkeyResponse = create(response.data, VkeyResponseSS);
      return vkeyResponse;
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffWithJitter(attempt)));
      // todo: consider adding a logger log here .onRetry with `datadog = true` to monitor the error rates
    }
  }
}
