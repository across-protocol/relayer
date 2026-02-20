import { APIGaslessDepositResponse, BridgeWitnessData, GaslessDepositMessage, DepositWithBlock } from "../interfaces";
import { Address, convertRelayDataParamsToBytes32, toBytes32 } from "../utils";
import { AugmentedTransaction } from "../clients";
import { Contract, BigNumber } from "ethers";

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

function normalizeSignature(signature: string): string {
  const hex = signature.startsWith("0x") ? signature : `0x${signature}`;
  if (hex.length !== 132) {
    throw new Error("receiveWithAuthSignature must be 65 bytes (132 hex chars)");
  }
  return hex;
}

/**
 * Returns a depositWithAuthorization AugmentedTransaction for a restructured gasless deposit.
 * All deposit-with-authorization wiring (params, contract-shaped deposit data, args) is done here.
 * Caller can add message/mrkdwn when submitting (e.g. for logging).
 */
export function buildGaslessDepositTx(
  depositMessage: GaslessDepositMessage,
  spokePoolPeripheryContract: Contract
): AugmentedTransaction {
  const { permit, inputAmount, baseDepositData, submissionFees, spokePool, nonce, signature } = depositMessage;
  const { from: signatureOwner, validBefore, validAfter } = permit.message;
  const witnessData: BridgeWitnessData = { inputAmount, baseDepositData, submissionFees, spokePool, nonce };
  const depositData = toContractDepositData(witnessData);
  const args = [
    signatureOwner,
    depositData,
    BigNumber.from(validAfter),
    BigNumber.from(validBefore),
    normalizeSignature(signature),
  ];
  return {
    contract: spokePoolPeripheryContract,
    chainId: depositMessage.originChainId,
    method: "depositWithAuthorization",
    args,
    ensureConfirmation: true,
  };
}

/**
 * Returns a FillRelay transaction based on a restructured gasless deposit.
 */
export function buildGaslessFillRelayTx(
  deposit: Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber">,
  spokePool: Contract,
  repaymentChainId: number,
  repaymentAddress: Address
): AugmentedTransaction {
  const { destinationChainId } = deposit;
  return {
    contract: spokePool,
    chainId: destinationChainId,
    method: "fillRelay",
    ensureConfirmation: true,
    args: [convertRelayDataParamsToBytes32(deposit), repaymentChainId, repaymentAddress.toBytes32()],
  };
}
