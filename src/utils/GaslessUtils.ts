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
  fetchTokenInfo,
  getProvider,
  toBN,
  toBytes32,
  toAddressType,
  CHAIN_IDs,
  MAX_UINT_VAL,
  toBNWei,
  winston,
  isDefined,
  getInventoryEquivalentL1TokenAddress,
  getTokenSymbol,
} from "../utils";
import { isStablecoin } from "./TokenUtils";
import { AugmentedTransaction } from "../clients";
import { Contract, BigNumber, ethers } from "ethers";
import { integer, is, max, min, string, type } from "superstruct";

// Token metadata (symbol/decimals) is immutable, so on-chain probe results are cached
// aggressively to keep the resolver off the RPC hot path once a token has been seen.
const GASLESS_TOKEN_INFO_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Minimal cache surface used by {@link resolveTokenInfoForLog} (backed by Redis in prod). */
export type TokenInfoCache = {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, val: T, expirySeconds?: number): Promise<string | undefined>;
};

// `{ symbol, decimals }` shape that is safe to pass to `createFormatFunction` for a log line.
// Decimals must be an integer in the ERC-20 `uint8` range (0–255); negative, fractional,
// infinite, or oversized values can assert or explode exponentiation in the formatter.
const TokenInfoForLog = type({
  symbol: string(),
  decimals: max(min(integer(), 0), 255),
});

/** True when `info` matches {@link TokenInfoForLog}. */
export function isValidTokenInfoForLog(info: unknown): info is { symbol: string; decimals: number } {
  return is(info, TokenInfoForLog);
}

/**
 * Resolve a token's `{ symbol, decimals }` for logging WITHOUT throwing.
 *
 * Gasless swapAndBridge deposits carry a user-signed `swapToken` that is frequently a
 * long-tail token absent from the static `TOKEN_SYMBOLS_MAP`. `getTokenInfo` throws for
 * those, and previously that rejection propagated out of `GaslessRelayer#initiateDeposit`
 * and silently dropped the deposit before it was ever submitted (ACB-552). This resolver
 * never throws: static map → Redis-cached on-chain ERC-20 probe → neutral placeholder.
 *
 * The result feeds only a Slack log line (never the on-chain deposit), so a placeholder or
 * slightly-off value can at most make a log entry less precise — it cannot affect deposit
 * correctness.
 *
 * @param token The token whose display info is needed.
 * @param chainId The chain the token lives on.
 * @param logger Logger for the (best-effort) on-chain probe-failure warning.
 * @param opts.redisCache Optional cache; misses trigger an on-chain probe, hits are reused.
 * @param opts.probeOnChain Injectable on-chain lookup (defaults to a live provider probe).
 */
export async function resolveTokenInfoForLog(
  token: Address,
  chainId: number,
  logger: winston.Logger,
  opts: {
    redisCache?: TokenInfoCache;
    probeOnChain?: (address: string, chainId: number) => Promise<{ symbol: string; decimals: number }>;
  } = {}
): Promise<{ symbol: string; decimals: number }> {
  try {
    const { symbol, decimals } = getTokenInfo(token, chainId);
    return { symbol, decimals };
  } catch {
    // Not in the static map — fall through to the on-chain probe below.
  }

  const address = token.toNative();
  const cacheKey = `gasless:tokenInfo:${chainId}:${address}`;
  const { redisCache } = opts;

  let cached: string | null = null;
  try {
    cached = (await redisCache?.get<string>(cacheKey)) ?? null;
  } catch {
    // Best-effort cache read — fall through to the probe on any error.
  }
  if (isDefined(cached)) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      // Reject negative/fractional/oversized decimals — they can crash createFormatFunction.
      if (isValidTokenInfoForLog(parsed)) {
        return parsed;
      }
    } catch {
      // Corrupt cache entry — ignore and re-probe.
    }
  }

  const probeOnChain = opts.probeOnChain ?? defaultOnChainTokenInfoProbe;
  let info: { symbol: string; decimals: number } | undefined = undefined;
  try {
    info = await probeOnChain(address, chainId);

    await redisCache?.set(cacheKey, JSON.stringify(info), GASLESS_TOKEN_INFO_CACHE_TTL_SECONDS);
    return info;
  } catch (error) {
    if (isDefined(info)) {
      return info;
    }

    logger.warn({
      at: "GaslessUtils#resolveTokenInfoForLog",
      message: "Failed to resolve token info on-chain; using placeholder for log line only",
      token: address,
      chainId,
      error,
    });
    return { symbol: "UNKNOWN", decimals: 18 };
  }
}

async function defaultOnChainTokenInfoProbe(
  address: string,
  chainId: number
): Promise<{ symbol: string; decimals: number }> {
  const provider = await getProvider(chainId);
  const { symbol, decimals } = await fetchTokenInfo(address, provider);
  return { symbol, decimals };
}

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
 * Normalizes a 2-byte integrator ID to lowercase `0x` + 4 hex chars.
 * Accepts optional `0x` prefix and any hex letter casing. Returns undefined when invalid.
 */
export function normalizeIntegratorId(integratorId: string): string | undefined {
  const stripped = integratorId.replace(/^0x/i, "");
  const lowered = stripped.toLowerCase();
  if (lowered.length !== 4 || !/^[0-9a-f]{4}$/.test(lowered)) {
    return undefined;
  }
  return `0x${lowered}`;
}

/**
 * Appends `[delimiter][integratorId]` to encoded calldata.
 * integratorId must be a hex string representing exactly 2 bytes (e.g. "0xABCD").
 */
export function tagIntegratorId(txData: string, integratorId: string): string {
  const normalized = normalizeIntegratorId(integratorId);
  if (!normalized) {
    throw new Error(`integratorId must be exactly 2 bytes (4 hex chars), got "${integratorId}"`);
  }
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
    const { chainId: originChainId, to: targetAddress, data } = swapTx;
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
          targetAddress,
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
        targetAddress,
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

// Previous SpokePoolPeriphery generations, by chain. Most EVM chains share one CREATE2
// deploy; zk-stack chains and the Avalanche/Robinhood cohort had their own.
const LEGACY_SPOKE_POOL_PERIPHERY_DEFAULT = ["0x10D8b8DaA26d307489803e10477De69C0492B610"];
const LEGACY_SPOKE_POOL_PERIPHERY_EXCEPTIONS: { [chainId: number]: string[] } = {
  [CHAIN_IDs.AVALANCHE]: ["0xe05E3798Ce2ae9afCb637fb53BF5a51253BBe2af"],
  [CHAIN_IDs.ROBINHOOD]: ["0xe05E3798Ce2ae9afCb637fb53BF5a51253BBe2af"],
  [CHAIN_IDs.LENS]: ["0x5a148a9260c1f670429361c34d40b477280f01a9"],
  [CHAIN_IDs.ZK_SYNC]: ["0x5a148a9260c1f670429361c34d40b477280f01a9"],
};

/**
 * Previous SpokePoolPeriphery generations that remain valid gasless deposit targets on a chain.
 *
 * A gasless deposit can only ever execute against the exact periphery generation the user's
 * signature binds: the signed EIP-3009/Permit2/EIP-2612 payload names the periphery as the
 * token-level payee and witness verifier, so submitting it anywhere else reverts. During a
 * periphery migration the API may still be quoting — or have in-flight intents signed
 * against — the previous generation, so the relayer accepts these addresses as deposit
 * targets alongside its default. This lets the relayer roll forward before the API cutover
 * and keep draining old-generation intents afterwards.
 *
 * Retire entries once the API no longer quotes the generation and in-flight authorizations
 * (bounded by their ~25-minute `validBefore`) have drained.
 */
export function getLegacySpokePoolPeripheryAddresses(chainId: number): string[] {
  return LEGACY_SPOKE_POOL_PERIPHERY_EXCEPTIONS[chainId] ?? LEGACY_SPOKE_POOL_PERIPHERY_DEFAULT;
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

// EOA signatures are exactly 65 bytes; smart-wallet (EIP-1271 / ERC-6492) signatures are longer
// and must be submitted via the periphery's *Bytes methods, which forward them to the token's
// bytes-signature EIP-3009 overload. The quote API applies the same dispatch at simulation time.
function normalizeAuthSignature(signature: string): { signature: string; isSmartWallet: boolean } {
  const hex = signature.startsWith("0x") ? signature : `0x${signature}`;
  if (hex.length < 132) {
    throw new Error("receiveWithAuthSignature must be at least 65 bytes (132 hex chars)");
  }
  return { signature: hex, isSmartWallet: hex.length > 132 };
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

/**
 * swapAndBridgeWithPermit: permit consumption is tracked on SpokePoolPeriphery (`permitNonces(address)`, 0x191d0ffc),
 * not on the swap token's EIP-2612 `nonces`. Returns true after the permit has been executed on-chain
 * (`permitNonces(owner) > signedNonce`).
 */
export async function isErc2612PermitNonceConsumed(params: {
  spokePoolPeriphery: Contract;
  owner: string;
  signedNonce: string;
}): Promise<boolean> {
  const onChainNonce = await params.spokePoolPeriphery.permitNonces(params.owner);
  return onChainNonce.gt(params.signedNonce);
}

/**
 * EIP-3009 `authorizationState(authorizer, nonce)`: true once the authorization has been redeemed.
 * A direct storage read, so unlike {@link GaslessRelayer._findAuthorizationUsed} it is not bounded by
 * the event search lookback — an authorization spent before the lookback window still reports true.
 */
export async function isErc3009AuthorizationUsed(
  authToken: Contract,
  authorizer: string,
  nonce: string
): Promise<boolean> {
  return await authToken.authorizationState(authorizer, nonce);
}

/**
 * The window in which the signed authorization can be redeemed, normalized to bounds that are both
 * *inclusive*, plus the signed fields themselves for the log line. Each flow's contract draws its
 * boundaries differently, and getting one wrong yields a `permanent` verdict on a live authorization, so
 * the conversion lives here next to the contract behavior that defines it:
 *
 *   - EIP-3009 `_requireValidAuthorization` requires `now > validAfter` *and* `now < validBefore` — both
 *     signed bounds are exclusive, so the redeemable range is [validAfter + 1, validBefore - 1].
 *   - Permit2 `SignatureTransfer` reverts only on `now > deadline`, so `deadline` itself is redeemable.
 *
 * The EIP-2612 flow deliberately reports no window. Its `permitApprovalDeadline` bounds only the token's
 * `permit` call, which `SpokePoolPeriphery.swapAndBridgeWithPermit` wraps in try/catch before falling
 * through to `transferFrom` — so a deposit whose approval deadline has passed still executes against an
 * allowance the depositor already holds. {@link findGaslessSubmitBlocker} checks that allowance instead.
 */
export function getGaslessAuthorizationWindow(depositMessage: AnyGaslessDepositMessage): {
  /** Earliest timestamp at which the authorization can be redeemed, inclusive. */
  earliestValid?: number;
  /** Latest timestamp at which the authorization can be redeemed, inclusive. */
  latestValid?: number;
  /** The signed values, reported as-is so a log line quotes what the depositor actually signed. */
  signed: { validAfter?: number; validBefore?: number; deadline?: number };
} {
  switch (depositMessage.permitType) {
    case "erc3009": {
      const { validAfter, validBefore } = (depositMessage.permit as ReceiveWithAuthorization).message;
      return {
        earliestValid: Number(validAfter) + 1,
        latestValid: Number(validBefore) - 1,
        signed: { validAfter: Number(validAfter), validBefore: Number(validBefore) },
      };
    }
    case "permit2": {
      const { deadline } = (depositMessage.permit as Permit2Permit | Permit2SwapAndBridgePermit).message;
      return { latestValid: Number(deadline), signed: { deadline: Number(deadline) } };
    }
    case "permit":
      return { signed: {} };
  }
}

/**
 * The EIP-2612 approval deadline, which only the swap-and-bridge `permit` flow carries. Inclusive: both
 * OpenZeppelin's `ERC20Permit` and Circle's `EIP2612` accept `now == deadline`.
 */
function getErc2612ApprovalDeadline(depositMessage: AnyGaslessDepositMessage): number | undefined {
  if (depositMessage.permitType !== "permit" || depositMessage.depositFlowType !== "swapAndBridge") {
    return undefined;
  }
  const { permitApprovalDeadline } = depositMessage;
  return isDefined(permitApprovalDeadline) ? Number(permitApprovalDeadline) : undefined;
}

/**
 * The token amount the depositor must hold for the origin deposit to execute.
 *
 * Every periphery entrypoint pulls the witnessed transfer amount *plus* `submissionFees.amount`
 * (`inputAmount + fee` bridging, `swapTokenAmount + fee` swapping), so that sum — not the permit's own
 * amount — is what the token balance is measured against. The two diverge in both directions: the
 * witness amount alone omits the fee, while a Permit2 `permitted.amount` is only an upper bound on a
 * possibly smaller requested transfer, and the EIP-2612 flow signs no value at all. EIP-3009 is the one
 * exact case, since `receiveWithAuthorization` transfers precisely the signed `value` — which is this
 * same sum, or the signature would not recover.
 */
export function getGaslessRequiredBalance(depositMessage: AnyGaslessDepositMessage): BigNumber {
  const transferAmount =
    depositMessage.depositFlowType === "swapAndBridge" ? depositMessage.swapTokenAmount : depositMessage.inputAmount;

  return toBN(transferAmount).add(toBN(depositMessage.submissionFees.amount));
}

/**
 * Returns true when the signed nonce has already been consumed on-chain, i.e. the authorization
 * cannot be redeemed a second time. Each permit flow tracks consumption in its own place — see
 * {@link isErc3009AuthorizationUsed}, {@link isPermit2NonceUsed} and {@link isErc2612PermitNonceConsumed}.
 */
export async function isGaslessAuthorizationConsumed(params: {
  depositMessage: AnyGaslessDepositMessage;
  /** Token carrying the EIP-3009 authorization (`erc3009` only). */
  authToken?: Contract;
  /** Permit2 on the origin chain (`permit2` only). */
  permit2?: Contract;
  /** Periphery the message targets (`permit` only) — permitNonces is periphery-local storage. */
  spokePoolPeriphery?: Contract;
}): Promise<boolean | undefined> {
  const { depositMessage, authToken, permit2, spokePoolPeriphery } = params;
  const authorizer = getGaslessAuthorizerAddress(depositMessage);
  const nonce = getGaslessPermitNonce(depositMessage);

  switch (depositMessage.permitType) {
    case "erc3009":
      return isDefined(authToken) ? await isErc3009AuthorizationUsed(authToken, authorizer, nonce) : undefined;
    case "permit2":
      return isDefined(permit2) ? await isPermit2NonceUsed(permit2, authorizer, nonce) : undefined;
    case "permit":
      return isDefined(spokePoolPeriphery)
        ? await isErc2612PermitNonceConsumed({ spokePoolPeriphery, owner: authorizer, signedNonce: nonce })
        : undefined;
  }
}

/** Why a gasless deposit cannot currently be submitted. See {@link findGaslessSubmitBlocker}. */
export type GaslessSubmitBlocker = {
  /** Machine-readable classification, stable for log filtering and alerting. */
  code:
    | "authorization-expired"
    | "authorization-not-yet-valid"
    | "authorization-consumed"
    | "insufficient-balance"
    | "insufficient-allowance";
  /** One-line human-readable summary, safe to put straight into a log message. */
  detail: string;
  /**
   * True when nothing the depositor does can make this deposit submittable: the signed authorization
   * is spent, or its validity window has closed. False means blocked *now* but recoverable — an
   * underfunded depositor who tops up before the authorization expires still gets their deposit.
   */
  permanent: boolean;
  /** Structured fields to attach to the log line. */
  context: Record<string, unknown>;
};

/**
 * Diagnoses why an origin-chain gasless deposit won't submit, for deposits the API keeps serving but
 * that can never land — the relayer otherwise retries them every poll until the authorization expires,
 * with no reason recorded (the simulation revert is swallowed by `sendAndConfirmTransaction`).
 *
 * Purely diagnostic: four read-only calls at most, and it never throws. A read that fails returns
 * `undefined` (unknown, not "fine"), so callers must not treat `undefined` as a clean bill of health.
 *
 * Checks run cheapest-and-most-conclusive first: signed validity window (free), then nonce consumption,
 * then depositor balance, then — for an EIP-2612 permit past its deadline — standing allowance.
 *
 * @dev Callers must only invoke this for a submission that failed *before* broadcast (see
 * {@link TransactionSimulationError}). A consumed nonce or a moved balance says nothing about the
 * deposit if the caller's own transaction is what consumed or moved it.
 */
export async function findGaslessSubmitBlocker(params: {
  depositMessage: AnyGaslessDepositMessage;
  currentTime: number;
  /** Origin-chain token contract for the amount the depositor must hold (input or swap token). */
  amountToken?: Contract;
  /** Token carrying the EIP-3009 authorization (`erc3009` only). */
  authToken?: Contract;
  permit2?: Contract;
  spokePoolPeriphery?: Contract;
}): Promise<GaslessSubmitBlocker | undefined> {
  const { depositMessage, currentTime, amountToken, authToken, permit2, spokePoolPeriphery } = params;
  const authorizer = getGaslessAuthorizerAddress(depositMessage);
  const nonce = getGaslessPermitNonce(depositMessage);

  try {
    // Both bounds are inclusive (see getGaslessAuthorizationWindow), so a deposit sitting exactly on its
    // last redeemable second is still submittable — calling it expired there would cache a permanent
    // verdict on a live authorization.
    const { earliestValid, latestValid, signed } = getGaslessAuthorizationWindow(depositMessage);
    if (isDefined(latestValid) && currentTime > latestValid) {
      return {
        code: "authorization-expired",
        detail: `Signed authorization was last redeemable at ${latestValid} (now ${currentTime}).`,
        permanent: true,
        context: { authorizer, nonce, ...signed, latestValid, currentTime },
      };
    }
    if (isDefined(earliestValid) && currentTime < earliestValid) {
      return {
        code: "authorization-not-yet-valid",
        detail: `Signed authorization is not redeemable until ${earliestValid} (now ${currentTime}).`,
        permanent: false,
        context: { authorizer, nonce, ...signed, earliestValid, currentTime },
      };
    }

    // Consumed nonce with no deposit located means the authorization was redeemed by something
    // other than this relayer's tracked submission; it can never be redeemed again.
    const consumed = await isGaslessAuthorizationConsumed({ depositMessage, authToken, permit2, spokePoolPeriphery });
    if (consumed) {
      return {
        code: "authorization-consumed",
        detail: "Signed nonce is already consumed on-chain; the authorization cannot be redeemed again.",
        permanent: true,
        context: { authorizer, nonce, permitType: depositMessage.permitType },
      };
    }

    if (isDefined(amountToken)) {
      const required = getGaslessRequiredBalance(depositMessage);
      const balance: BigNumber = await amountToken.balanceOf(authorizer);
      if (balance.lt(required)) {
        return {
          code: "insufficient-balance",
          detail: `Depositor holds ${balance.toString()} of the ${required.toString()} required to submit.`,
          permanent: false,
          context: {
            authorizer,
            nonce,
            token: amountToken.address,
            balance: balance.toString(),
            required: required.toString(),
            shortfall: required.sub(balance).toString(),
          },
        };
      }

      // EIP-2612 only, and only once the approval deadline has passed (exclusively: `now == deadline` is
      // still redeemable). The periphery wraps its `permit` call in try/catch — so that a permit already
      // redeemed by somebody else does not brick the deposit — and pulls the tokens with `transferFrom`
      // regardless. Past the deadline the deposit lands only on an allowance already in place.
      //
      // @dev Deliberately not checked before the deadline, even though a permit redeemed externally and
      // then revoked leaves the allowance short while the deadline is still future. A short allowance is
      // the *normal* pre-permit state (the permit is what grants it), so reading it earlier would report
      // `insufficient-allowance` for every EIP-2612 deposit that fails simulation for an unrelated
      // reason — a false blocker on the common case to catch a rare one. Distinguishing the two needs the
      // signed approval nonce, which the API does not send; were it available, redeemability would be one
      // `nonces(owner)` comparison, exactly as isErc2612PermitNonceConsumed does for the witness nonce.
      const approvalDeadline = getErc2612ApprovalDeadline(depositMessage);
      if (isDefined(approvalDeadline) && currentTime > approvalDeadline && isDefined(spokePoolPeriphery)) {
        const spender = spokePoolPeriphery.address;
        const allowance: BigNumber = await amountToken.allowance(authorizer, spender);
        if (allowance.lt(required)) {
          return {
            code: "insufficient-allowance",
            detail:
              `Signed EIP-2612 approval expired at ${approvalDeadline} (now ${currentTime}) and the depositor's ` +
              `standing allowance of ${allowance.toString()} is below the ${required.toString()} required to submit.`,
            // The signed permit is spent, but an allowance granted directly to the periphery still lets
            // this deposit through, so the depositor is not out of options.
            permanent: false,
            context: {
              authorizer,
              nonce,
              token: amountToken.address,
              spender,
              allowance: allowance.toString(),
              required: required.toString(),
              permitApprovalDeadline: approvalDeadline,
              currentTime,
            },
          };
        }
      }
    }
  } catch {
    // Diagnosis is best-effort: a failed read must not mask the underlying submission failure.
    return undefined;
  }

  return undefined;
}

/**
 * Builds calldata for SpokePoolPeriphery.depositWithAuthorization[Bytes](signatureOwner, depositData, validAfter, validBefore, signature).
 * The *Bytes variant is used for smart-wallet (>65-byte) signatures.
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
  const { signature: authSignature, isSmartWallet } = normalizeAuthSignature(signature);
  const method = isSmartWallet ? "depositWithAuthorizationBytes" : "depositWithAuthorization";
  const args = [signatureOwner, depositData, BigNumber.from(validAfter), BigNumber.from(validBefore), authSignature];

  if (integratorId) {
    const calldata = spokePoolPeripheryContract.interface.encodeFunctionData(method, args);
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
    method,
    args,
    ensureConfirmation: true,
    spray: depositMessage.originChainId === CHAIN_IDs.MAINNET, // If mainnet, send to all available private RPCs.
  };
}

/**
 * Builds the origin-chain deposit tx for any gasless API message: bridge (depositWithAuthorization[Bytes] /
 * depositWithPermit2) or swap-and-bridge (swapAndBridgeWithAuthorization[Bytes] / swapAndBridgeWithPermit2).
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
 * Builds calldata for SpokePoolPeriphery.swapAndBridgeWithAuthorization[Bytes] or .swapAndBridgeWithPermit2
 * depending on {@link SwapAndBridgeGaslessDepositMessage.permitType} (and signature length for erc3009).
 */
export function buildSwapAndBridgeDepositTx(
  depositMessage: SwapAndBridgeGaslessDepositMessage,
  spokePoolPeripheryContract: Contract
): AugmentedTransaction {
  const swapAndDepositData = toContractSwapAndDepositData(depositMessage);

  let method:
    | "swapAndBridgeWithAuthorization"
    | "swapAndBridgeWithAuthorizationBytes"
    | "swapAndBridgeWithPermit2"
    | "swapAndBridgeWithPermit";
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
    const {
      from: signatureOwner,
      validAfter,
      validBefore,
    } = (depositMessage.permit as ReceiveWithAuthorization).message;
    const { signature: authSignature, isSmartWallet } = normalizeAuthSignature(depositMessage.signature);
    method = isSmartWallet ? "swapAndBridgeWithAuthorizationBytes" : "swapAndBridgeWithAuthorization";
    args = [signatureOwner, swapAndDepositData, BigNumber.from(validAfter), BigNumber.from(validBefore), authSignature];
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
 * @param fillsEnabled When false, skip token-pair and amount checks (origin deposit only; no fill).
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
  depositUsdPageThreshold = 0,
  fillsEnabled = true
): boolean {
  if (!fillsEnabled) {
    return true;
  }

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
