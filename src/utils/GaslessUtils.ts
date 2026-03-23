import {
  APIGaslessDepositResponse,
  BaseDepositData,
  BridgeWitnessData,
  GaslessDepositMessage,
  ReceiveWithAuthorization,
  RelayData,
  Permit2Permit,
} from "../interfaces";
import type { AllowedPeggedPairs } from "../gasless/GaslessRelayerConfig";
import {
  Address,
  assert,
  ConvertDecimals,
  convertRelayDataParamsToBytes32,
  getL1TokenAddress,
  getTokenInfo,
  toBytes32,
  toAddressType,
  CHAIN_IDs,
  MAX_UINT_VAL,
} from "../utils";
import { AugmentedTransaction } from "../clients";
import { Contract, BigNumber, ethers } from "ethers";

const DOMAIN_CALLDATA_DELIMITER = "0x1dc0de";

/*
 * The exclusivityParameter argument is interpreted depending on its relationship to 1 year in seconds.
 * Below 1 year, it represents a relative timestamp. Above 1 year, it represents an absolute timestamp.
 * See SpokePool:
 * https://github.com/across-protocol/contracts/blob/33e6fd20947c4bdf8682f45770e468577e9142ea/contracts/SpokePool.sol#L166
 */
export const MAX_EXCLUSIVITY_PERIOD_SECONDS = 31_536_000;
export function isExclusivityRelative(exclusivityParameter: number): boolean {
  return exclusivityParameter > 0 && exclusivityParameter <= MAX_EXCLUSIVITY_PERIOD_SECONDS;
}

/**
 * Returns true if the input/output token pair is allowed for gasless: either same L1 token,
 * or (inputSymbol, outputSymbol) is in allowedPeggedPairs (e.g. { "USDT": ["USDC"] }).
 */
export function isAllowedGaslessPair(
  inputToken: Address | string,
  outputToken: Address | string,
  originChainId: number,
  destinationChainId: number,
  allowedPeggedPairs: AllowedPeggedPairs = {}
): boolean {
  const inputAddr = typeof inputToken === "string" ? toAddressType(inputToken, originChainId) : inputToken;
  const outputAddr = typeof outputToken === "string" ? toAddressType(outputToken, destinationChainId) : outputToken;
  const inputL1 = getL1TokenAddress(inputAddr, originChainId);
  const outputL1 = getL1TokenAddress(outputAddr, destinationChainId);
  if (inputL1.eq(outputL1)) {
    return true;
  }
  if (Object.keys(allowedPeggedPairs).length === 0) {
    return false;
  }
  try {
    const inputSymbol = getTokenInfo(inputL1, CHAIN_IDs.MAINNET).symbol;
    const outputSymbol = getTokenInfo(outputL1, CHAIN_IDs.MAINNET).symbol;
    return allowedPeggedPairs[inputSymbol]?.has(outputSymbol) ?? false;
  } catch {
    return false;
  }
}

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
 * Supports both ReceiveWithAuthorization and Permit2; permitType indicates which flow to use.
 */
export function restructureGaslessDeposits(depositMessages: APIGaslessDepositResponse[]): GaslessDepositMessage[] {
  return depositMessages.map((msg) => {
    const { swapTx, requestId, signature } = msg;
    const { chainId: originChainId, data } = swapTx;
    const { depositId, permit, witness, integratorId } = data;
    const witnessData = witness.BridgeWitness.data;
    const { inputAmount, baseDepositData, submissionFees, spokePool, nonce } = witnessData;
    const permitType = data.type === "permit2" ? "permit2" : "receiveWithAuthorization";
    return {
      originChainId,
      depositId,
      requestId,
      signature,
      permitType,
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

function toBytes(value: string): string {
  if (value.startsWith("0x")) {
    return value;
  }
  return "0x" + Buffer.from(value, "utf8").toString("hex");
}

/**
 * Normalizes BaseDepositData fields to match on-chain encoding.
 * This ensures consistent data representation between deposit submission and fill paths.
 * CRITICAL: Both toContractDepositData and buildSyntheticDeposit must apply the same
 * normalizations to prevent relay data hash mismatches.
 */
function normalizeBaseDepositData(bdd: BaseDepositData): BaseDepositData {
  return {
    ...bdd,
    message: toBytes(bdd.message), // Convert plain text to hex bytes
  };
}

/**
 * Maps API BridgeWitness.data to the shape and types expected by the contract ABI.
 * - Field names must match the contract (DepositData / BaseDepositData).
 * - Contract expects bytes32 for outputToken, recipient, exclusiveRelayer; bytes for message.
 * - Contract BaseDepositData has no exclusivityDeadline (only exclusivityParameter).
 */
function toContractDepositData(data: BridgeWitnessData) {
  const bdd = normalizeBaseDepositData(data.baseDepositData);
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
      message: bdd.message, // Already normalized by normalizeBaseDepositData
    },
    inputAmount: data.inputAmount,
    spokePool: data.spokePool,
    nonce: data.nonce,
  };
}

function normalizeSignature(signature: string): string {
  const hex = signature.startsWith("0x") ? signature : `0x${signature}`;
  if (hex.length !== 132) {
    throw new Error("receiveWithAuthSignature must be 65 bytes (132 hex chars)");
  }
  return hex;
}

function normalizeSignatureBytes(signature: string): string {
  return signature.startsWith("0x") ? signature : `0x${signature}`;
}

/**
 * Builds calldata for SpokePoolPeriphery.depositWithPermit2(signatureOwner, depositData, permit, signature).
 * Uses witness data (same as depositWithAuthorization) and Permit2 permit message fields.
 */
export function buildPermit2GaslessDepositTx(
  depositMessage: GaslessDepositMessage,
  spokePoolPeripheryContract: Contract
): AugmentedTransaction {
  if (depositMessage.permitType !== "permit2") {
    throw new Error("buildPermit2GaslessDepositTx requires permitType === 'permit2'");
  }
  const { permit, inputAmount, baseDepositData, submissionFees, spokePool, nonce, signature, integratorId } =
    depositMessage;
  const permit2 = permit as Permit2Permit;
  const signatureOwner = baseDepositData.depositor;
  const witnessData: BridgeWitnessData = { inputAmount, baseDepositData, submissionFees, spokePool, nonce };
  const depositData = toContractDepositData(witnessData);
  const permitStruct = {
    permitted: {
      token: permit2.message.permitted.token,
      amount: BigNumber.from(permit2.message.permitted.amount),
    },
    nonce: BigNumber.from(permit2.message.nonce),
    deadline: BigNumber.from(permit2.message.deadline),
  };
  const signatureBytes = normalizeSignatureBytes(signature);
  const args = [signatureOwner, depositData, permitStruct, signatureBytes];

  if (integratorId) {
    const calldata = spokePoolPeripheryContract.interface.encodeFunctionData("depositWithPermit2", args);
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
    method: "depositWithPermit2",
    args,
    ensureConfirmation: true,
    spray: depositMessage.originChainId === CHAIN_IDs.MAINNET,
  };
}

/**
 * Authorizer/signer address for logging or lookup. ReceiveWithAuthorization: permit.message.from; Permit2: baseDepositData.depositor.
 */
export function getGaslessAuthorizerAddress(depositMessage: GaslessDepositMessage): string {
  if (depositMessage.permitType === "permit2") {
    return depositMessage.baseDepositData.depositor;
  }
  return (depositMessage.permit as ReceiveWithAuthorization).message.from;
}

/**
 * Permit nonce for lookup/dedup. Both permit types have message.nonce.
 */
export function getGaslessPermitNonce(depositMessage: GaslessDepositMessage): string {
  return depositMessage.permit.message.nonce;
}

/**
 * Builds calldata for SpokePoolPeriphery.depositWithAuthorization(signatureOwner, depositData, validAfter, validBefore, signature).
 */
export function buildReceiveWithAuthorizationGaslessDepositTx(
  depositMessage: GaslessDepositMessage,
  spokePoolPeripheryContract: Contract
): AugmentedTransaction {
  const { permit, inputAmount, baseDepositData, submissionFees, spokePool, nonce, signature, integratorId } =
    depositMessage;
  const { from: signatureOwner, validBefore, validAfter } = (permit as ReceiveWithAuthorization).message;
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
 * Returns a depositWithAuthorization or depositWithPermit2 AugmentedTransaction based on permitType.
 */
export function buildGaslessDepositTx(
  depositMessage: GaslessDepositMessage,
  spokePoolPeripheryContract: Contract
): AugmentedTransaction {
  return depositMessage.permitType === "permit2"
    ? buildPermit2GaslessDepositTx(depositMessage, spokePoolPeripheryContract)
    : buildReceiveWithAuthorizationGaslessDepositTx(depositMessage, spokePoolPeripheryContract);
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
 * IMPORTANT: Uses normalizeBaseDepositData to ensure fields match on-chain deposit encoding.
 * CRITICAL: Only safe to call with absolute exclusivityParameter (not relative).
 */
export function buildSyntheticDeposit(msg: GaslessDepositMessage): RelayData & { destinationChainId: number } {
  const { originChainId } = msg;
  const bdd = normalizeBaseDepositData(msg.baseDepositData);
  const { destinationChainId } = bdd;

  // CRITICAL: Verify exclusivityParameter is absolute, not relative.
  // Relative parameters cannot be used for immediate fill because we can't know
  // the actual exclusivityDeadline until the deposit mines on-chain.
  assert(
    !isExclusivityRelative(bdd.exclusivityParameter),
    `exclusivityParameter is not absolute (${bdd.exclusivityParameter})`
  );

  return {
    originChainId,
    depositor: toAddressType(bdd.depositor, originChainId),
    recipient: toAddressType(bdd.recipient, destinationChainId),
    depositId: BigNumber.from(msg.depositId),
    inputToken: toAddressType(bdd.inputToken, originChainId),
    inputAmount: BigNumber.from(bdd.inputAmount),
    outputToken: toAddressType(bdd.outputToken, destinationChainId),
    outputAmount: BigNumber.from(bdd.outputAmount),
    message: bdd.message, // Already normalized by normalizeBaseDepositData
    fillDeadline: bdd.fillDeadline,
    exclusiveRelayer: toAddressType(bdd.exclusiveRelayer, destinationChainId),
    exclusivityDeadline: bdd.exclusivityDeadline,
    destinationChainId,
  };
}

/**
 * Simple validation function for deposit tokens & amounts.
 * @param allowRefundFlowTest When true, deposits with inputAmount < outputAmount and outputAmount === MAX_UINT_VAL are considered valid (for refund-flow testing).
 * @param allowedPeggedPairs When provided, input/output pairs in this map (e.g. { "USDC": ["USDH"] }) are allowed in addition to same-L1 pairs.
 */
export function validateDeposit(
  originChainId: number,
  inputToken: Address,
  inputAmount: BigNumber,
  destinationChainId: number,
  outputToken: Address,
  outputAmount: BigNumber,
  allowRefundFlowTest = false,
  allowedPeggedPairs: AllowedPeggedPairs = {}
): boolean {
  if (!isAllowedGaslessPair(inputToken, outputToken, originChainId, destinationChainId, allowedPeggedPairs)) {
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
