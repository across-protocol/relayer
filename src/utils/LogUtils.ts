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
