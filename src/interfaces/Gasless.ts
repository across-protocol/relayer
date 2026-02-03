import { SortableEvent } from "./";

export interface AuthorizationUsed extends SortableEvent {
  authorizer: string;
  nonce: string;
}

export interface GaslessDepositMessage {
  chainId: number;
  to: string;
  data: {
    depositId: string;
    witness: [
      {
        submissionFees: Fees;
        baseDepositData: BaseDepositData;
        inputAmount: string;
      },
      {
        submissionFees: Fees;
        depositData: BaseDepositData;
        swapToken: string;
        exchange: string;
        transferType: string;
        swapTokenAmount: string;
        minExpectedInputTokenAmount: string;
        routerCalldata: string;
        enableProportionalAdjustment: boolean;
        spokePool: string;
        nonce: string;
      }
    ];
    permit: ReceiveWithAuthorization;
    domainSeparator: string;
    integratorId: string;
  };
}

interface ReceiveWithAuthorization {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: number;
    validBefore: number;
    nonce: string;
  };
}

interface Fees {
  amount: string;
  recipient: string;
}

export interface BaseDepositData {
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
  message: string;
}
