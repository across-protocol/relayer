/** EIP-712 typed data for ReceiveWithAuthorization (used in swapTx.typedData) */
export interface TypedDataReceiveWithAuthorizationEIP712 {
  types: {
    ReceiveWithAuthorization: Array<{ name: string; type: string }>;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  primaryType: string;
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: number;
    validBefore: number;
    nonce: string;
  };
}

// ---------------------------------------------------------------------------
// Witness data shapes
// ---------------------------------------------------------------------------

/** Bridge-only witness data inside witness.BridgeWitness.data */
export interface BridgeWitnessData {
  inputAmount: string;
  baseDepositData: BaseDepositData;
  submissionFees: Fees;
  spokePool: string;
  nonce: string;
}

/**
 * Deposit data inside BridgeAndSwapWitnessData / SwapAndDepositData.
 * Same shape as BaseDepositData minus inputAmount — the user supplies swapToken
 * (not inputToken) so the actual inputAmount is determined by the swap at execution time.
 */
export interface SwapBaseDepositData {
  inputToken: string;
  outputToken: string;
  outputAmount: string;
  depositor: string;
  recipient: string;
  destinationChainId: number;
  exclusiveRelayer: string;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityParameter: number;
  exclusivityDeadline: number;
  message: string;
}

/**
 * Swap-and-bridge witness data inside witness.BridgeAndSwapWitness.data (raw API).
 * transferType and enableProportionalAdjustment arrive as protobuf-wrapped objects
 * ({ long: number } and { boolean: boolean }).  They are plain primitives in the Permit2 witness.
 */
export interface BridgeAndSwapWitnessData {
  submissionFees: Fees;
  depositData: SwapBaseDepositData;
  swapToken: string;
  exchange: string;
  /** Raw API: { long: number }. Permit2 witness: number (uint8). */
  transferType: { long: number } | number;
  swapTokenAmount: string;
  minExpectedInputTokenAmount: string;
  routerCalldata: string;
  /** Raw API: { boolean: boolean }. Permit2 witness: boolean. */
  enableProportionalAdjustment: { boolean: boolean } | boolean;
  spokePool: string;
  nonce: string;
}

/**
 * SwapAndDepositData as it appears inside a Permit2 PermitWitnessTransferFrom witness.
 * transferType and enableProportionalAdjustment are plain primitives (no protobuf wrapping).
 */
export interface SwapAndDepositData {
  submissionFees: Fees;
  depositData: SwapBaseDepositData;
  swapToken: string;
  exchange: string;
  transferType: number;
  swapTokenAmount: string;
  minExpectedInputTokenAmount: string;
  routerCalldata: string;
  enableProportionalAdjustment: boolean;
  spokePool: string;
  nonce: string;
}

// ---------------------------------------------------------------------------
// Permit shapes
// ---------------------------------------------------------------------------

/** EIP-712 typed data for ReceiveWithAuthorization (EIP-3009) permit */
export interface ReceiveWithAuthorization {
  types: {
    EIP712Domain?: Array<{ name: string; type: string }>;
    ReceiveWithAuthorization: Array<{ name: string; type: string }>;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  primaryType: string;
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: number;
    validBefore: number;
    nonce: string;
  };
}

/** Permit2 PermitWitnessTransferFrom for bridge-only flow. */
export interface Permit2Permit {
  types: Record<string, Array<{ name: string; type: string }>>;
  domain: { name: string; chainId: number; verifyingContract: string };
  primaryType: string;
  message: {
    permitted: { token: string; amount: string };
    spender: string;
    nonce: string;
    deadline: number;
    witness: {
      inputAmount: string;
      baseDepositData: BaseDepositData;
      submissionFees: Fees;
      spokePool: string;
      nonce: string;
    };
  };
}

/** Permit2 PermitWitnessTransferFrom for swap-and-bridge flow; witness is SwapAndDepositData. */
export interface Permit2SwapAndBridgePermit {
  types: Record<string, Array<{ name: string; type: string }>>;
  domain: { name: string; chainId: number; verifyingContract: string };
  primaryType: string;
  message: {
    permitted: { token: string; amount: string };
    spender: string;
    nonce: string;
    deadline: number;
    witness: SwapAndDepositData;
  };
}

/** EIP-712 witness for swap-and-bridge + EIP-2612 permit flow (not Permit2). */
export interface PermitSwapAndBridgeWitness {
  types: Record<string, Array<{ name: string; type: string }>>;
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  primaryType: string;
  message: SwapAndDepositData;
}

// ---------------------------------------------------------------------------
// Raw API response shapes
// ---------------------------------------------------------------------------

/** Optional metadata present in swap-and-bridge API responses. */
export interface GaslessDepositMetadata {
  bridgeType?: string;
  destinationChainId?: number;
  instantFill?: boolean;
}

/** Raw API response for bridge-only deposits (BridgeWitness). */
export interface APIGaslessBridgeDepositResponse {
  swapTx: {
    ecosystem: string;
    chainId: number;
    to: string;
    /** Present for EIP-3009; null or absent for Permit2. */
    typedData?: { TypedDataReceiveWithAuthorizationEIP712: TypedDataReceiveWithAuthorizationEIP712 } | null;
    data: {
      type: string;
      depositId: string;
      witness: {
        BridgeWitness: {
          type: string;
          data: BridgeWitnessData;
        };
      };
      permit: ReceiveWithAuthorization | Permit2Permit;
      domainSeparator: string;
      integratorId?: string;
      metadata?: GaslessDepositMetadata;
    };
  };
  signature: string;
  submittedAt: string;
  requestId: string;
  messageId: string;
}

/** Raw API response for swap-and-bridge deposits (BridgeAndSwapWitness). */
export interface APIGaslessSwapAndBridgeDepositResponse {
  swapTx: {
    ecosystem: string;
    chainId: number;
    to: string;
    typedData: null;
    data: {
      type: string;
      depositId: string;
      witness: {
        BridgeAndSwapWitness: {
          type: string;
          data: BridgeAndSwapWitnessData;
        };
      };
      permit: ReceiveWithAuthorization | Permit2SwapAndBridgePermit | PermitSwapAndBridgeWitness;
      domainSeparator: string;
      integratorId?: string;
      metadata?: GaslessDepositMetadata;
    };
  };
  signature: string;
  submittedAt: string;
  requestId: string;
  messageId: string;
  /** EIP-2612 permit signature for token approval (swapAndBridgeWithPermit). */
  permitApprovalSignature?: string;
  /** EIP-2612 permit deadline used for token approval (swapAndBridgeWithPermit). */
  permitApprovalDeadline?: number;
}

/**
 * Union of all raw gasless API response shapes.
 * Discriminate by checking the witness key:
 *   "BridgeWitness" in response.swapTx.data.witness      → bridge-only
 *   "BridgeAndSwapWitness" in response.swapTx.data.witness → swap-and-bridge
 */
export type APIGaslessDepositResponse = APIGaslessBridgeDepositResponse | APIGaslessSwapAndBridgeDepositResponse;

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export interface Fees {
  amount: string;
  recipient: string;
}

export interface BaseDepositData {
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  outputAmount: string;
  depositor: string;
  recipient: string;
  destinationChainId: number;
  exclusiveRelayer: string;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  exclusivityParameter: number;
  message: string;
}

export interface DepositWithAuthorizationParams {
  signatureOwner: string;
  depositData: BridgeWitnessData;
  validAfter: bigint;
  validBefore: bigint;
  receiveWithAuthSignature: string;
}

// ---------------------------------------------------------------------------
// Flattened message types (post-restructure)
// ---------------------------------------------------------------------------

/** Discriminant for which permit flow a gasless message uses. */
export const GASLESS_TYPES = ["erc3009", "permit2", "permit"] as const;

export type GaslessPermitType = (typeof GASLESS_TYPES)[number];

/**
 * Flattened bridge-only gasless deposit message.
 * Use after restructureGaslessDeposits(). Use permitType to branch when building the tx.
 */
export interface GaslessDepositMessage {
  depositFlowType: "bridge";
  originChainId: number;
  depositId: string;
  requestId: string;
  signature: string;
  permitType: GaslessPermitType;
  permit: ReceiveWithAuthorization | Permit2Permit;
  /** Destructured from BridgeWitnessData. */
  inputAmount: string;
  baseDepositData: BaseDepositData;
  submissionFees: Fees;
  spokePool: string;
  nonce: string;
  integratorId?: string;
  metadata?: GaslessDepositMetadata;
}

/**
 * Flattened swap-and-bridge gasless deposit message.
 * No inputAmount — use swapTokenAmount / minExpectedInputTokenAmount instead.
 * depositData replaces baseDepositData (same shape minus inputAmount).
 */
export interface SwapAndBridgeGaslessDepositMessage {
  depositFlowType: "swapAndBridge";
  originChainId: number;
  depositId: string;
  requestId: string;
  signature: string;
  permitType: GaslessPermitType;
  permit: ReceiveWithAuthorization | Permit2SwapAndBridgePermit | PermitSwapAndBridgeWitness;
  /** Required for permitType === "permit" (EIP-2612 flow). */
  permitApprovalSignature?: string;
  /** Required for permitType === "permit" (EIP-2612 flow). */
  permitApprovalDeadline?: number;
  /** Destructured from BridgeAndSwapWitnessData. */
  depositData: SwapBaseDepositData;
  submissionFees: Fees;
  swapToken: string;
  exchange: string;
  transferType: number;
  swapTokenAmount: string;
  minExpectedInputTokenAmount: string;
  routerCalldata: string;
  enableProportionalAdjustment: boolean;
  spokePool: string;
  nonce: string;
  integratorId?: string;
  metadata?: GaslessDepositMetadata;
}

/**
 * Union of all flattened gasless deposit message types.
 * Discriminate with depositFlowType: "bridge" | "swapAndBridge".
 */
export type AnyGaslessDepositMessage = GaslessDepositMessage | SwapAndBridgeGaslessDepositMessage;
