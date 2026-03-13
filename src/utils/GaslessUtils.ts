import { APIGaslessDepositResponse, BridgeWitnessData, GaslessDepositMessage, RelayData } from "../interfaces";
import {
  Address,
  ConvertDecimals,
  convertRelayDataParamsToBytes32,
  getL1TokenAddress,
  getTokenInfo,
  toAddressType,
  toBytes32,
  CHAIN_IDs,
  MAX_UINT_VAL,
} from "../utils";
import { AugmentedTransaction } from "../clients";
import { Contract, BigNumber, ethers } from "ethers";

const DOMAIN_CALLDATA_DELIMITER = "0x1dc0de";

/**
 * Appends `[delimiter][integratorId]` to encoded calldata.
 * integratorId must be a hex string representing exactly 2 bytes (e.g. "0xABCD").
 */
export function tagIntegratorId(txData: string, integratorId: string): string {
  const stripped = integratorId.startsWith("0x") ? integratorId.slice(2) : integratorId;
  if (stripped.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(stripped)) {
    throw new Error(`integratorId must be exactly 2 bytes (4 hex chars), got "${integratorId}"`);
  }
  const normalized = "0x" + stripped;
  return ethers.utils.hexConcat([txData, DOMAIN_CALLDATA_DELIMITER, normalized]);
}

/**
 * Restructures raw API deposits into a flatter shape so callers don't deal with
 * swapTx.data.witness.BridgeWitness.data etc. Call this once when you receive the API response.
 */
export function restructureGaslessDeposits(depositMessages: APIGaslessDepositResponse[]): GaslessDepositMessage[] {
  return depositMessages.map((msg) => {
    const { swapTx, requestId, signature } = msg;
    const { chainId: originChainId, data } = swapTx;
    const { depositId, permit, witness, integratorId } = data;
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
      integratorId,
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
  const { permit, inputAmount, baseDepositData, submissionFees, spokePool, nonce, signature, integratorId } =
    depositMessage;
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

  if (integratorId) {
    const calldata = spokePoolPeripheryContract.interface.encodeFunctionData("depositWithAuthorization", args);
    const taggedCalldata = tagIntegratorId(calldata, integratorId);
    return {
      contract: spokePoolPeripheryContract,
      chainId: depositMessage.originChainId,
      method: "",
      args: [taggedCalldata],
      ensureConfirmation: true,
    };
  }

  return {
    contract: spokePoolPeripheryContract,
    chainId: depositMessage.originChainId,
    method: "depositWithAuthorization",
    args,
    ensureConfirmation: true,
    spray: depositMessage.originChainId === CHAIN_IDs.MAINNET, // If mainnet, send to all available private RPCs.
  };
}

/**
 * Returns a FillRelay transaction based on a restructured gasless deposit.
 */
export function buildGaslessFillRelayTx(
  deposit: RelayData & { destinationChainId: number },
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

/**
 * Constructs a deposit-shaped object from a gasless API message, for use in the immediate fill path
 * where the fill is submitted before the deposit is confirmed on-chain.
 */
export function buildSyntheticDeposit(msg: GaslessDepositMessage): RelayData & { destinationChainId: number } {
  const { originChainId, baseDepositData: bdd } = msg;
  const { destinationChainId } = bdd;

  return {
    originChainId,
    depositor: toAddressType(bdd.depositor, originChainId),
    recipient: toAddressType(bdd.recipient, destinationChainId),
    depositId: BigNumber.from(msg.depositId),
    inputToken: toAddressType(bdd.inputToken, originChainId),
    inputAmount: BigNumber.from(bdd.inputAmount),
    outputToken: toAddressType(bdd.outputToken, destinationChainId),
    outputAmount: BigNumber.from(bdd.outputAmount),
    message: bdd.message,
    fillDeadline: bdd.fillDeadline,
    exclusiveRelayer: toAddressType(bdd.exclusiveRelayer, destinationChainId),
    exclusivityDeadline: bdd.exclusivityDeadline,
    destinationChainId,
  };
}

/**
 * Simple validation function for deposit tokens & amounts.
 * @param allowRefundFlowTest When true, deposits with inputAmount < outputAmount and outputAmount === MAX_UINT_VAL are considered valid (for refund-flow testing).
 */
export function validateDeposit(
  originChainId: number,
  inputToken: Address,
  inputAmount: BigNumber,
  destinationChainId: number,
  outputToken: Address,
  outputAmount: BigNumber,
  allowRefundFlowTest = false
): boolean {
  // Ensure that the input token is the same as the output token.
  const inputTokenL1Address = getL1TokenAddress(inputToken, originChainId);
  const outputTokenL1Address = getL1TokenAddress(outputToken, destinationChainId);
  // If the input token is different from the output token, then keep the deposit as observed and do not submit a deposit.
  if (!inputTokenL1Address.eq(outputTokenL1Address)) {
    return false;
  }

  const inputTokenInfo = getTokenInfo(inputToken, originChainId);
  const outputTokenInfo = getTokenInfo(outputToken, destinationChainId);
  const inputAmountInOutputTokenDecimals = ConvertDecimals(
    inputTokenInfo.decimals,
    outputTokenInfo.decimals
  )(inputAmount);
  // If the input amount is less than the output amount, reject unless refund-flow test is enabled and outputAmount === MAX_UINT_VAL.
  if (inputAmountInOutputTokenDecimals.lt(outputAmount)) {
    return allowRefundFlowTest ? outputAmount.eq(MAX_UINT_VAL) : false;
  }

  return true;
}
