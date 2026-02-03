import { SortableEvent } from "./";

export interface AuthorizationUsed extends SortableEvent {
  authorizer: string;
  nonce: string;
}

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

/** Full gasless API response: swapTx + signature + submittedAt + requestId */
export interface GaslessDepositMessage {
  swapTx: {
    ecosystem: string;
    chainId: number;
    to: string;
    typedData?: {
      // @TODO: Check with backend team if this will be removed or not
      TypedDataReceiveWithAuthorizationEIP712: TypedDataReceiveWithAuthorizationEIP712;
    };
    data: {
      type: string;
      depositId: string;
      witness: {
        // @TODO: witness object can have BridgeWitness or BridgeAndSwapWitness. Add support for BridgeAndSwapWitness when we get a schema.
        BridgeWitness: {
          type: string;
          data: BridgeWitnessData;
        };
      };
      permit: ReceiveWithAuthorization;
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
