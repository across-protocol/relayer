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

export async function getVkeyWithRetries(apiBaseUrl: string): Promise<AxiosResponse<VkeyResponse>> {
  const apiClient = axios.create();
  axiosRetry(apiClient, {
    retries: 3,
    retryDelay: (retry) => backoffWithJitter(retry),
    // todo: consider adding a logger log here .onRetry with `datadog = true` to monitor the error rates
  });
  return apiClient.get<VkeyResponse>(`${apiBaseUrl}/v1/api/vkey`);
}

export async function getProofStateWithRetries(apiBaseUrl: string, proofId: string): Promise<ProofStateResponse> {
  const apiClient = axios.create();
  axiosRetry(apiClient, {
    retries: 3,
    retryDelay: (retry) => backoffWithJitter(retry),
    // todo: consider adding a logger log here .onRetry with `datadog = true` to monitor the error rates
  });
  const response = await apiClient.get<ProofStateResponse>(`${apiBaseUrl}/v1/api/proofs/${proofId}`);
  return response.data;
}

export async function requestProofWithRetries(apiBaseUrl: string, request: ApiProofRequest) {
  const apiClient = axios.create();
  axiosRetry(apiClient, {
    retries: 3,
    retryDelay: (retry) => backoffWithJitter(retry),
    // Notice: sometimes, the API returns status 409: conflict. This means that 2 different post requests raced to
    // request a ZK proof with the same args and it's unclear whether the request was created successfully yet. The easy
    // thing to do is to retry and receive a 200 response most likely
    retryCondition: (err) => isNetworkOrIdempotentRequestError(err) || err.response?.status === 409,
    // todo: consider adding a logger log here .onRetry with `datadog = true` to monitor the error rates
  });
  await axios.post(`${apiBaseUrl}/v1/api/proofs`, request);
}
