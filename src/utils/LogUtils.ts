import { arch } from "@across-protocol/sdk";

export type DefaultLogLevels = "debug" | "info" | "warn" | "error";

export function stringifyThrownValue(value: unknown): string {
  if (value instanceof Error) {
    const errToString = value.toString();
    return value.stack
      ? value.stack
      : value.message || errToString !== "[object Object]"
        ? errToString
        : `could not extract error from 'Error' instance ${errToString}`;
  } else if (value instanceof Object) {
    const objStringified = JSON.stringify(value);
    return objStringified !== "{}"
      ? objStringified
      : `could not extract error from 'Object' instance ${objStringified}`;
  } else {
    return `ThrownValue: ${value?.toString()}`;
  }
}

type SolanaErrorDescription = {
  name: string;
  message?: string;
  code: number;
  context: unknown;
  cause?: SolanaErrorDescription | { message: string };
};

// Winston's `error` formatter (in @risk-labs/logger) collapses a SolanaError to its `.stack` string,
// which drops `.context` (the RPC simulation result: `logs`, `accounts`, `unitsConsumed`) and `.cause`
// (the underlying `InstructionError` / `TransactionError`). Spread the result of this helper into a
// log payload alongside `error: err` to keep both the human-readable stack and the structured
// diagnostic fields.
export function describeSolanaError(err: unknown): { solanaError?: SolanaErrorDescription } {
  if (!arch.svm.isSolanaError(err)) {
    return {};
  }
  const solanaError: SolanaErrorDescription = {
    name: err.name,
    code: err.context.__code,
    context: err.context,
  };
  if (err instanceof Error) {
    solanaError.message = err.message;
  }
  if (err.cause !== undefined) {
    const describedCause = describeSolanaError(err.cause);
    if (describedCause.solanaError) {
      solanaError.cause = describedCause.solanaError;
    } else if (err.cause instanceof Error) {
      solanaError.cause = { message: err.cause.message };
    }
  }
  return { solanaError };
}

// Anchor emits a `Program log: AnchorError ... Error Code: <Name>. Error Number: <N>. Error Message: ...`
// line in the simulation logs whenever a `#[error_code]` variant fires. Match by name rather than the
// numeric code because the SVM SpokePool program declares two `#[error_code]` enums (`CommonError`,
// `SvmError`) that both default-start at offset 6000 and collide at the wire level — the deployed-IDL
// gap means only `SvmError` is exposed as numbered constants, so name-matching is the only reliable
// path to disambiguate `ClaimedMerkleLeaf` from e.g. `SvmError::InvalidRefund`.
const SVM_LEAF_ALREADY_CLAIMED_LOG_FRAGMENT = "Error Code: ClaimedMerkleLeaf";

/**
 * True iff `err` is a Solana preflight failure whose simulation logs indicate that the targeted
 * relayer-refund merkle leaf has already been claimed on chain (`CommonError::ClaimedMerkleLeaf`
 * in `programs/svm-spoke/src/instructions/bundle.rs`). Use to suppress benign races between
 * concurrent dataworker actors.
 */
export function isSvmLeafAlreadyClaimedError(err: unknown): boolean {
  if (!arch.svm.isSolanaError(err)) {
    return false;
  }
  if (err.context.__code !== arch.svm.SVM_TRANSACTION_PREFLIGHT_FAILURE) {
    return false;
  }
  const logs = err.context.logs;
  if (!Array.isArray(logs)) {
    return false;
  }
  return logs.some((line) => typeof line === "string" && line.includes(SVM_LEAF_ALREADY_CLAIMED_LOG_FRAGMENT));
}
