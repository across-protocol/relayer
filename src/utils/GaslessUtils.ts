import { DepositWithAuthorizationParams, GaslessDepositMessage } from "../interfaces";
import { Contract, PopulatedTransaction } from "ethers";

/**
 * Returns the full populated transaction.
 */
export async function buildDepositWithAuthorizationTx(
  message: GaslessDepositMessage,
  spokePoolPeripheryContract: Contract
): Promise<PopulatedTransaction> {
  const params = buildDepositWithAuthorizationParams(message);

  const depositDataStruct = {
    submissionFees: params.depositData.submissionFees,
    baseDepositData: params.depositData.baseDepositData,
    inputAmount: params.depositData.inputAmount,
    spokePool: params.depositData.spokePool,
    nonce: params.depositData.nonce,
  };

  const tx = await spokePoolPeripheryContract.populateTransaction.depositWithAuthorization(
    params.signatureOwner,
    depositDataStruct,
    params.validAfter,
    params.validBefore,
    params.receiveWithAuthSignature
  );

  return tx;
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
