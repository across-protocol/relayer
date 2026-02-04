import { BridgeWitnessData, DepositWithAuthorizationParams, GaslessDepositMessage } from "../interfaces";

/**
 * Maps API BridgeWitness.data to the shape and types expected by the contract ABI.
 * - Field names must match the contract (DepositData / BaseDepositData).
 * - Contract expects bytes32 for outputToken, recipient, exclusiveRelayer; bytes for message.
 * - Contract BaseDepositData has no exclusivityDeadline (only exclusivityParameter).
 */
function toContractDepositData(data: BridgeWitnessData) {
  const bdd = data.baseDepositData;
  return {
    submissionFees: data.submissionFees,
    baseDepositData: {
      inputToken: bdd.inputToken,
      outputToken: toBytes32(bdd.outputToken),
      outputAmount: bdd.outputAmount,
      depositor: bdd.depositor,
      recipient: toBytes32(bdd.recipient),
      destinationChainId: bdd.destinationChainId,
      exclusiveRelayer: toBytes32(bdd.exclusiveRelayer),
      quoteTimestamp: bdd.quoteTimestamp,
      fillDeadline: bdd.fillDeadline,
      exclusivityParameter: bdd.exclusivityParameter,
      message: toBytes(bdd.message),
    },
    inputAmount: data.inputAmount,
    spokePool: data.spokePool,
    nonce: data.nonce,
  };
}

function toBytes32(value: string): string {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (hex.length >= 64) {
    return value.startsWith("0x") ? value : `0x${value}`;
  }
  return "0x" + hex.toLowerCase().padStart(64, "0");
}

function toBytes(value: string): string {
  if (value.startsWith("0x")) {
    return value;
  }
  return "0x" + Buffer.from(value, "utf8").toString("hex");
}

/**
 * Returns the arguments for depositWithAuthorization in the order and shape expected by the contract.
 * Use with runTransaction(logger, contract, "depositWithAuthorization", getDepositWithAuthorizationArgs(message), value).
 */
export function getDepositWithAuthorizationArgs(message: GaslessDepositMessage): unknown[] {
  const params = buildDepositWithAuthorizationParams(message);
  const depositData = toContractDepositData(params.depositData);
  return [params.signatureOwner, depositData, params.validAfter, params.validBefore, params.receiveWithAuthSignature];
}

/**
 * Builds the full parameters for depositWithAuthorization from a GaslessDepositMessage.
 * Uses message.signature as the EIP-3009 receiveWithAuth signature (65 bytes hex).
 */
export function buildDepositWithAuthorizationParams(message: GaslessDepositMessage): DepositWithAuthorizationParams {
  const depositData = message.swapTx.data.witness.BridgeWitness.data;
  const permit = message.swapTx.data.permit;

  return {
    signatureOwner: permit.message.from,
    depositData,
    validAfter: BigInt(permit.message.validAfter),
    validBefore: BigInt(permit.message.validBefore),
    receiveWithAuthSignature: normalizeSignature(message.signature),
  };
}

// Checks if the signature is valid and returns it in the correct format.
function normalizeSignature(signature: string): string {
  const hex = signature.startsWith("0x") ? signature : `0x${signature}`;
  if (hex.length !== 132) {
    throw new Error("receiveWithAuthSignature must be 65 bytes (132 hex chars)");
  }
  return hex;
}
