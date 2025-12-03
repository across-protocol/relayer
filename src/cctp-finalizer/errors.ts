export abstract class CCTPError extends Error {
  abstract readonly shouldRetry: boolean;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class NoAttestationFoundError extends CCTPError {
  readonly shouldRetry = true;
  readonly code = "NO_ATTESTATION_FOUND";

  constructor(burnTransactionHash: string) {
    super(`No attestation found for the burn transaction: ${burnTransactionHash}`);
  }
}

export class AttestationNotReadyError extends CCTPError {
  readonly shouldRetry = true;
  readonly code = "ATTESTATION_NOT_READY";

  constructor(status: string) {
    super(`Attestation not ready. Status: ${status}`);
  }
}

export class AlreadyProcessedError extends CCTPError {
  readonly shouldRetry = false;
  readonly code = "ALREADY_PROCESSED";

  constructor() {
    super("Message has already been processed on-chain");
  }
}

export class SvmPrivateKeyNotConfiguredError extends CCTPError {
  readonly shouldRetry = false;
  readonly code = "SVM_PRIVATE_KEY_NOT_CONFIGURED";

  constructor() {
    super("SVM private key not configured for Solana CCTP finalization");
  }
}

export class RpcUrlNotConfiguredError extends CCTPError {
  readonly shouldRetry = false;
  readonly code = "RPC_URL_NOT_CONFIGURED";

  constructor(chainId: number) {
    super(`No RPC URL configured for chain ID ${chainId}`);
  }
}

export class MintTransactionFailedError extends CCTPError {
  readonly shouldRetry = true;
  readonly code = "MINT_TRANSACTION_FAILED";

  constructor(originalError: Error | unknown) {
    const message = originalError instanceof Error ? originalError.message : "Mint transaction failed";
    super(message);
    if (originalError instanceof Error) {
      this.cause = originalError;
    }
  }
}

export class PrivateKeyNotFoundError extends CCTPError {
  readonly shouldRetry = false;
  readonly code = "PRIVATE_KEY_NOT_FOUND";

  constructor(type: "evm" | "svm") {
    super(`No private key found for ${type}`);
  }
}

export function isCCTPError(error: unknown): error is CCTPError {
  return error instanceof CCTPError;
}
