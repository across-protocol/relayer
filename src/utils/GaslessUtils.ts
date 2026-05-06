import {
  AnyGaslessDepositMessage,
  APIGaslessDepositResponse,
  APIGaslessSwapAndBridgeDepositResponse,
  BaseDepositData,
  BridgeWitnessData,
  GaslessDepositMessage,
  GaslessPermitType,
  ReceiveWithAuthorization,
  RelayData,
  Permit2Permit,
  Permit2SwapAndBridgePermit,
  SwapAndBridgeGaslessDepositMessage,
  GASLESS_TYPES,
} from "../interfaces";
import type { AllowedPeggedPairs } from "../gasless/GaslessRelayerConfig";
import {
  Address,
  assert,
  ConvertDecimals,
  convertRelayDataParamsToBytes32,
  getTokenInfo,
  toBN,
  toBytes32,
  toAddressType,
  CHAIN_IDs,
  MAX_UINT_VAL,
  TOKEN_SYMBOLS_MAP,
  Provider,
  toBNWei,
  winston,
  isDefined,
  getInventoryEquivalentL1TokenAddress,
  getTokenSymbol,
} from "../utils";
import { AugmentedTransaction } from "../clients";
import { Contract, BigNumber, ethers } from "ethers";

/**
 * Pulls normalized token/amount/deadline fields from a bridge or swap-and-bridge gasless message.
 */
export function extractGaslessDepositFields(depositMessage: AnyGaslessDepositMessage): {
  destinationChainId: number;
  fillDeadline: number;
  inputToken: Address;
  outputToken: Address;
  /** Bridge: signed input amount. Swap: min expected input token after swap. */
  inputAmountForValidation: BigNumber;
  outputAmount: BigNumber;
  exclusivityParameter: number;
  swapToken?: string;
  swapTokenAmount?: string;
} {
  const { originChainId } = depositMessage;
  const bd =
    depositMessage.depositFlowType === "swapAndBridge" ? depositMessage.depositData : depositMessage.baseDepositData;
  const { destinationChainId } = bd;

  const inputAmountForValidation =
    depositMessage.depositFlowType === "swapAndBridge"
      ? toBN(depositMessage.minExpectedInputTokenAmount)
      : toBN(depositMessage.baseDepositData.inputAmount);

  const swapAndBridgeOnlyFields =
    depositMessage.depositFlowType === "swapAndBridge"
      ? { swapToken: depositMessage.swapToken, swapTokenAmount: depositMessage.swapTokenAmount }
      : {};

  return {
    destinationChainId,
    fillDeadline: bd.fillDeadline,
    inputToken: toAddressType(bd.inputToken, originChainId),
    outputToken: toAddressType(bd.outputToken, destinationChainId),
    inputAmountForValidation,
    outputAmount: toBN(bd.outputAmount),
    exclusivityParameter: bd.exclusivityParameter,
    ...swapAndBridgeOnlyFields,
  };
}

const DOMAIN_CALLDATA_DELIMITER = "0x1dc0de";
export function isGaslessPermitType(value: string): value is GaslessPermitType {
  return GASLESS_TYPES.includes(value as GaslessPermitType);
}

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
 * Returns true if the token is a supported stablecoin for gasless deposits (USDC or USDT).
 * @param token The token address to check
 * @param chainId The chain ID where the token resides
 */
export function isStablecoin(token: Address, chainId: number): boolean {
  return [TOKEN_SYMBOLS_MAP.USDC, TOKEN_SYMBOLS_MAP.USDT].some(({ addresses }) =>
    token.eq(toAddressType(addresses[chainId], chainId))
  );
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

  const inputSymbol = getTokenSymbol(inputAddr, originChainId);
  const outputSymbol = getTokenSymbol(outputAddr, destinationChainId);
  if (allowedPeggedPairs[inputSymbol]?.has(outputSymbol)) {
    return true;
  }

  const inputL1 = getInventoryEquivalentL1TokenAddress(inputAddr, originChainId);
  const outputL1 = getInventoryEquivalentL1TokenAddress(outputAddr, destinationChainId);

  return inputL1.eq(outputL1) ?? false;
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
 * Supports bridge-only (BridgeWitness) and swap-and-bridge (BridgeAndSwapWitness) deposits.
 * Use depositFlowType to branch: "bridge" | "swapAndBridge".
 */
export function restructureGaslessDeposits(
  depositMessages: APIGaslessDepositResponse[],
  logger: winston.Logger
): AnyGaslessDepositMessage[] {
  return depositMessages.flatMap((msg): AnyGaslessDepositMessage[] => {
    const { swapTx, requestId, signature } = msg;
    const { chainId: originChainId, data } = swapTx;
    const { depositId, witness, integratorId, metadata, type: permitType } = data;
    if (!isGaslessPermitType(permitType)) {
      logger.warn({
        at: "GaslessUtils#restructureGaslessDeposits",
        message: "Skipping gasless deposit with unsupported permit type.",
        requestId,
        depositId,
        permitType,
      });
      return [];
    }

    if ("BridgeAndSwapWitness" in witness) {
      const raw = witness.BridgeAndSwapWitness.data;
      const swapMsg = msg as APIGaslessSwapAndBridgeDepositResponse;
      // Unwrap protobuf-style objects to plain primitives.
      const transferType = typeof raw.transferType === "number" ? raw.transferType : raw.transferType.long;
      const enableProportionalAdjustment =
        typeof raw.enableProportionalAdjustment === "boolean"
          ? raw.enableProportionalAdjustment
          : raw.enableProportionalAdjustment.boolean;
      return [
        {
          depositFlowType: "swapAndBridge",
          originChainId,
          depositId,
          requestId,
          signature,
          permitType,
          // permit type for this branch is erc3009 | Permit2SwapAndBridgePermit | EIP-2612 witness.
          // Cast required because data is still the union type after narrowing witness.
          permit: data.permit as SwapAndBridgeGaslessDepositMessage["permit"],
          permitApprovalSignature: swapMsg.permitApprovalSignature,
          permitApprovalDeadline: swapMsg.permitApprovalDeadline,
          depositData: raw.depositData,
          submissionFees: raw.submissionFees,
          swapToken: raw.swapToken,
          exchange: raw.exchange,
          transferType,
          swapTokenAmount: raw.swapTokenAmount,
          minExpectedInputTokenAmount: raw.minExpectedInputTokenAmount,
          routerCalldata: raw.routerCalldata,
          enableProportionalAdjustment,
          spokePool: raw.spokePool,
          nonce: raw.nonce,
          integratorId,
          metadata,
        },
      ];
    }

    const { inputAmount, baseDepositData, submissionFees, spokePool, nonce } = witness.BridgeWitness.data;
    return [
      {
        depositFlowType: "bridge",
        originChainId,
        depositId,
        requestId,
        signature,
        permitType,
        // permit type for this branch is erc3009 | Permit2Permit.
        // Cast required because data is still the union type after narrowing witness.
        permit: data.permit as GaslessDepositMessage["permit"],
        inputAmount,
        baseDepositData,
        submissionFees,
        spokePool,
        nonce,
        integratorId,
        metadata,
      },
    ];
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
 * Authorizer/signer address for logging or lookup.
 * EIP-3009 (erc3009): permit.message.from.
 * Permit2 bridge: baseDepositData.depositor.
 * Permit2 / EIP-2612 swapAndBridge: depositData.depositor.
 */
export function getGaslessAuthorizerAddress(depositMessage: AnyGaslessDepositMessage): string {
  if (["permit", "permit2"].includes(depositMessage.permitType)) {
    return depositMessage.depositFlowType === "swapAndBridge"
      ? depositMessage.depositData.depositor
      : depositMessage.baseDepositData.depositor;
  }
  return (depositMessage.permit as ReceiveWithAuthorization).message.from;
}

/**
 * Permit / witness nonce for lookup/dedup (Permit2, EIP-3009, or swap-and-bridge witness nonce).
 */
export function getGaslessPermitNonce(depositMessage: AnyGaslessDepositMessage): string {
  return depositMessage.permit.message.nonce;
}

/**
 * Returns true if Permit2 has marked this nonce used for the owner (permit already executed on-chain).
 * Used to detect prior submission when there is no EIP-3009 AuthorizationUsed or SpokePool FundsDeposited signal.
 * Uniswap documentation: https://docs.uniswap.org/contracts/permit2/reference/signature-transfer
 */
export async function isPermit2NonceUsed(permit2: Contract, owner: string, permitNonce: string): Promise<boolean> {
  const nonce = toBN(permitNonce);
  const wordPos = nonce.div(256);
  const bitPos = nonce.mod(256).toBigInt();
  const bitmapBn = await permit2.nonceBitmap(owner, wordPos);
  const bitmap = bitmapBn.toBigInt();
  return (bitmap & (1n << bitPos)) !== 0n;
}

const ERC2612_NONCES_ABI = ["function nonces(address owner) view returns (uint256)"];

export async function getTokenPermitNonce(params: {
  tokenAddress: string;
  owner: string;
  provider: Provider;
}): Promise<BigNumber> {
  const token = new Contract(params.tokenAddress, ERC2612_NONCES_ABI, params.provider);
  return token.nonces(params.owner);
}

/**
 * Returns true when the token's EIP-2612 nonce has advanced beyond the signed nonce.
 */
export async function isErc2612PermitNonceConsumed(params: {
  tokenAddress: string;
  owner: string;
  signedNonce: string;
  provider: Provider;
}): Promise<boolean> {
  const onChainNonce = await getTokenPermitNonce(params);
  return onChainNonce.gt(params.signedNonce);
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
 * Builds the origin-chain deposit tx for any gasless API message: bridge (depositWithAuthorization /
 * depositWithPermit2) or swap-and-bridge (swapAndBridgeWithAuthorization / swapAndBridgeWithPermit2).
 */
export function buildGaslessDepositTx(
  depositMessage: AnyGaslessDepositMessage,
  spokePoolPeripheryContract: Contract
): AugmentedTransaction {
  if (depositMessage.depositFlowType === "swapAndBridge") {
    return buildSwapAndBridgeDepositTx(depositMessage, spokePoolPeripheryContract);
  }
  return depositMessage.permitType === "permit2"
    ? buildPermit2GaslessDepositTx(depositMessage, spokePoolPeripheryContract)
    : buildReceiveWithAuthorizationGaslessDepositTx(depositMessage, spokePoolPeripheryContract);
}

/**
 * Maps a SwapAndBridgeGaslessDepositMessage to the SwapAndDepositData struct expected by the contract ABI.
 * Applies the same bytes32/bytes normalizations as toContractDepositData does for bridge-only deposits.
 */
function toContractSwapAndDepositData(msg: SwapAndBridgeGaslessDepositMessage) {
  const dd = msg.depositData;
  return {
    submissionFees: {
      amount: BigNumber.from(msg.submissionFees.amount),
      recipient: msg.submissionFees.recipient,
    },
    depositData: {
      inputToken: dd.inputToken,
      outputToken: toBytes32(dd.outputToken),
      outputAmount: BigNumber.from(dd.outputAmount),
      depositor: dd.depositor,
      recipient: toBytes32(dd.recipient),
      destinationChainId: dd.destinationChainId,
      exclusiveRelayer: toBytes32(dd.exclusiveRelayer),
      quoteTimestamp: dd.quoteTimestamp,
      fillDeadline: dd.fillDeadline,
      exclusivityParameter: dd.exclusivityParameter,
      message: toBytes(dd.message),
    },
    swapToken: msg.swapToken,
    exchange: msg.exchange,
    transferType: msg.transferType,
    swapTokenAmount: BigNumber.from(msg.swapTokenAmount),
    minExpectedInputTokenAmount: BigNumber.from(msg.minExpectedInputTokenAmount),
    routerCalldata: toBytes(msg.routerCalldata),
    enableProportionalAdjustment: msg.enableProportionalAdjustment,
    spokePool: msg.spokePool,
    nonce: BigNumber.from(msg.nonce),
  };
}

/**
 * Builds calldata for SpokePoolPeriphery.swapAndBridgeWithAuthorization or .swapAndBridgeWithPermit2
 * depending on {@link SwapAndBridgeGaslessDepositMessage.permitType}.
 */
export function buildSwapAndBridgeDepositTx(
  depositMessage: SwapAndBridgeGaslessDepositMessage,
  spokePoolPeripheryContract: Contract
): AugmentedTransaction {
  const swapAndDepositData = toContractSwapAndDepositData(depositMessage);

  let method: "swapAndBridgeWithAuthorization" | "swapAndBridgeWithPermit2" | "swapAndBridgeWithPermit";
  let args: unknown[];

  if (depositMessage.permitType === "permit2") {
    method = "swapAndBridgeWithPermit2";
    const permit2 = depositMessage.permit as Permit2SwapAndBridgePermit;
    args = [
      depositMessage.depositData.depositor,
      swapAndDepositData,
      {
        permitted: {
          token: permit2.message.permitted.token,
          amount: BigNumber.from(permit2.message.permitted.amount),
        },
        nonce: BigNumber.from(permit2.message.nonce),
        deadline: BigNumber.from(permit2.message.deadline),
      },
      normalizeSignatureBytes(depositMessage.signature),
    ];
  } else if (depositMessage.permitType === "permit") {
    method = "swapAndBridgeWithPermit";
    if (!depositMessage.permitApprovalSignature || !depositMessage.permitApprovalDeadline) {
      throw new Error("swapAndBridgeWithPermit requires permitApprovalSignature and permitApprovalDeadline");
    }
    const signatureOwner = depositMessage.depositData.depositor;
    args = [
      signatureOwner,
      swapAndDepositData,
      BigNumber.from(depositMessage.permitApprovalDeadline),
      normalizeSignatureBytes(depositMessage.permitApprovalSignature),
      normalizeSignatureBytes(depositMessage.signature),
    ];
  } else {
    method = "swapAndBridgeWithAuthorization";
    const {
      from: signatureOwner,
      validAfter,
      validBefore,
    } = (depositMessage.permit as ReceiveWithAuthorization).message;
    args = [
      signatureOwner,
      swapAndDepositData,
      BigNumber.from(validAfter),
      BigNumber.from(validBefore),
      normalizeSignature(depositMessage.signature),
    ];
  }

  if (depositMessage.integratorId) {
    const calldata = spokePoolPeripheryContract.interface.encodeFunctionData(method, args);
    const taggedCalldata = tagIntegratorId(calldata, depositMessage.integratorId);
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
    method,
    args,
    ensureConfirmation: true,
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
 * @param logger When set and `depositUsdPageThreshold` is positive, may emit `logger.error` for paging when input exceeds threshold (does not change validation result).
 * @param depositUsdPageThreshold USD nominal from config (`RELAYER_GASLESS_DEPOSIT_USD_PAGE_THRESHOLD`); `0` disables. USDC/USDT input treated as ~1 USD per token unit at chain-native decimals.
 */
export function validateDeposit(
  originChainId: number,
  inputToken: Address,
  inputAmount: BigNumber,
  destinationChainId: number,
  outputToken: Address,
  outputAmount: BigNumber,
  allowRefundFlowTest = false,
  allowedPeggedPairs: AllowedPeggedPairs = {},
  logger?: winston.Logger,
  depositUsdPageThreshold = 0
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

  if (isDefined(logger) && depositUsdPageThreshold > 0 && isStablecoin(inputToken, originChainId)) {
    const thresholdBn = toBNWei(depositUsdPageThreshold, inputTokenInfo.decimals);
    if (inputAmount.gt(thresholdBn)) {
      logger.error({
        at: "GaslessUtils#validateDeposit",
        message:
          "Gasless deposit input exceeds USD paging threshold (operational alert only; deposit may still be valid).",
        originChainId,
        thresholdUsd: depositUsdPageThreshold,
        inputToken: inputToken.toNative(),
        inputSymbol: inputTokenInfo.symbol,
        inputAmount: inputAmount.toString(),
      });
    }
  }

  return true;
}
