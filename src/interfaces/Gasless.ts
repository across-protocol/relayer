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

/** Bridge witness data inside witness.BridgeWitness.data */
export interface BridgeWitnessData {
  inputAmount: string;
  baseDepositData: BaseDepositData;
  submissionFees: Fees;
  spokePool: string;
  nonce: string;
}

/** Permit2 EIP-712 permit (PermitWitnessTransferFrom) in API response. */
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

/**
 * Raw gasless API response. Covers both ReceiveWithAuthorization and Permit2.
 * - typedData: set for EIP-3009, null or absent for Permit2.
 * - data.type: "permit2" for Permit2, any other string for ReceiveWithAuthorization.
 * - data.permit: shape depends on data.type (ReceiveWithAuthorization vs Permit2Permit).
 */
export interface APIGaslessDepositResponse {
  swapTx: {
    ecosystem: string;
    chainId: number;
    to: string;
    /** Present for EIP-3009 ReceiveWithAuthorization; null or absent for Permit2. */
    typedData?: {
      TypedDataReceiveWithAuthorizationEIP712: TypedDataReceiveWithAuthorizationEIP712;
    };
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
    };
  };
  signature: string;
  submittedAt: string;
  requestId: string;
  messageId: string;
}

/** EIP-712 typed data for ReceiveWithAuthorization (EIP-3009) permit */
export interface ReceiveWithAuthorization {
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

/** Discriminant for which permit flow a gasless message uses. */
export type GaslessPermitType = "receiveWithAuthorization" | "permit2";

/**
 * Gasless deposit message (flattened). Use after restructureGaslessDeposits(apiResponse.deposits).
 * Works for both ReceiveWithAuthorization and Permit2; use permitType to branch when building the tx.
 * witnessData is destructured so its fields are at top level for easier use.
 */
export interface GaslessDepositMessage {
  originChainId: number;
  depositId: string;
  requestId: string;
  signature: string;
  permitType: GaslessPermitType;
  permit: ReceiveWithAuthorization | Permit2Permit;
  /** Destructured from witnessData (BridgeWitnessData). */
  inputAmount: string;
  baseDepositData: BaseDepositData;
  submissionFees: Fees;
  spokePool: string;
  nonce: string;
  integratorId?: string;
}
