import {
  APIGaslessDepositResponse,
  BridgeWitnessData,
  DepositWithAuthorizationParams,
  GaslessDepositMessage,
} from "../interfaces";
import { Address, toBN, toAddressType, convertRelayDataParamsToBytes32, toBytes32 } from "../utils";
import { AugmentedTransaction } from "../clients";
import { Contract } from "ethers";

/**
 * Restructures raw API deposits into a flatter shape so callers don't deal with
 * swapTx.data.witness.BridgeWitness.data etc. Call this once when you receive the API response.
 */
export function restructureGaslessDeposits(depositMessages: APIGaslessDepositResponse[]): GaslessDepositMessage[] {
  return depositMessages.map((msg) => {
    const { swapTx, requestId, signature } = msg;
    const { chainId: originChainId, data } = swapTx;
    const { depositId, permit, witness } = data;
    const witnessData = witness.BridgeWitness.data;
    const { inputAmount, baseDepositData, submissionFees, spokePool, nonce } = witnessData;
    return {
      originChainId,
      depositId,
      requestId,
      signature,
      permit,
      inputAmount,
      baseDepositData,
      submissionFees,
      spokePool,
      nonce,
    };
  });
}

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
export function getDepositWithAuthorizationArgs(depositMessage: GaslessDepositMessage): unknown[] {
  const params = buildDepositWithAuthorizationParams(depositMessage);
  const depositData = toContractDepositData(params.depositData);
  return [params.signatureOwner, depositData, params.validAfter, params.validBefore, params.receiveWithAuthSignature];
}

/**
 * Builds the full parameters for depositWithAuthorization from a restructured deposit.
 */
export function buildDepositWithAuthorizationParams(depositMessage: GaslessDepositMessage): DepositWithAuthorizationParams {
  const { permit, inputAmount, baseDepositData, submissionFees, spokePool, nonce, signature } = depositMessage;
  const witnessData: BridgeWitnessData = { inputAmount, baseDepositData, submissionFees, spokePool, nonce };
  return {
    signatureOwner: permit.message.from,
    depositData: witnessData,
    validAfter: BigInt(permit.message.validAfter),
    validBefore: BigInt(permit.message.validBefore),
    receiveWithAuthSignature: normalizeSignature(signature),
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

/**
 * Returns a depositWithAuthorization AugmentedTransaction for a restructured gasless deposit.
 * Caller can add message/mrkdwn when submitting (e.g. for logging).
 */
export function buildGaslessDepositTx(
  depositMessage: GaslessDepositMessage,
  spokePoolPeripheryContract: Contract
): AugmentedTransaction {
  return {
    contract: spokePoolPeripheryContract,
    chainId: depositMessage.originChainId,
    method: "depositWithAuthorization",
    args: getDepositWithAuthorizationArgs(depositMessage),
    ensureConfirmation: true,
  };
}

/**
 * Returns a FillRelay transaction based on a restructured gasless deposit.
 */
export function buildGaslessFillRelayTx(
  depositMessage: GaslessDepositMessage,
  spokePool: Contract,
  repaymentChainId: number,
  repaymentAddress: Address
): AugmentedTransaction {
  const { originChainId, depositId, baseDepositData } = depositMessage;
  const { destinationChainId } = baseDepositData;
  const relayData = {
    depositor: toAddressType(baseDepositData.depositor, originChainId),
    recipient: toAddressType(baseDepositData.recipient, destinationChainId),
    inputToken: toAddressType(baseDepositData.inputToken, originChainId),
    outputToken: toAddressType(baseDepositData.outputToken, destinationChainId),
    inputAmount: toBN(baseDepositData.inputAmount),
    outputAmount: toBN(baseDepositData.outputAmount),
    exclusiveRelayer: toAddressType(baseDepositData.exclusiveRelayer, destinationChainId),
    depositId: toBN(depositId),
    originChainId,
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
