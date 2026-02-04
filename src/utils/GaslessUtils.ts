import { BridgeWitnessData, DepositWithAuthorizationParams, GaslessDepositMessage } from "../interfaces";
import { Address, toBN, toAddressType, convertRelayDataParamsToBytes32, toBytes32 } from "../utils";
import { AugmentedTransaction } from "../clients";
import { Contract } from "ethers";

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

function toBytes(value: string): string {
  if (value.startsWith("0x")) {
    return value;
  }
  return "0x" + Buffer.from(value, "utf8").toString("hex");
}

/**
 * Returns the arguments for depositWithAuthorization in the order and shape expected by the contract.
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

/*
 * Returns a FillRelay transaction based on the input deposit message.
 */
export function buildGaslessFillRelayTx(
  message: GaslessDepositMessage,
  spokePool: Contract,
  repaymentChainId: number,
  repaymentAddress: Address
): AugmentedTransaction {
  const { chainId, data } = message.swapTx;
  const { baseDepositData } = data.witness.BridgeWitness.data;
  const { destinationChainId } = baseDepositData;
  const relayData = {
    depositor: toAddressType(baseDepositData.depositor, chainId),
    recipient: toAddressType(baseDepositData.recipient, destinationChainId),
    inputToken: toAddressType(baseDepositData.inputToken, chainId),
    outputToken: toAddressType(baseDepositData.outputToken, destinationChainId),
    inputAmount: toBN(baseDepositData.inputAmount),
    outputAmount: toBN(baseDepositData.outputAmount),
    exclusiveRelayer: toAddressType(baseDepositData.exclusiveRelayer, destinationChainId),
    depositId: toBN(data.depositId),
    originChainId: chainId,
    fillDeadline: baseDepositData.fillDeadline,
    exclusivityDeadline: baseDepositData.exclusivityDeadline,
    message: baseDepositData.message,
  };
  return {
    contract: spokePool,
    chainId: destinationChainId,
    method: "fillRelay",
    args: [convertRelayDataParamsToBytes32(relayData), repaymentChainId, repaymentAddress.toBytes32()],
  };
}
