export type DefaultLogLevels = "debug" | "info" | "warn" | "error";

export function stringifyThrownValue(value: unknown): string {
  if (value instanceof Error) {
    const stackOrToString = value.stack || value.toString();

    // `.stack` (and `.toString()`) only carry `name`/`message`/the stack.
    // Capture extra structured fields attached to the error instance — most
    // notably the `context` on `@solana/errors` `SolanaError` (which carries
    // `__code` plus the RPC response's `value.err` and program `logs`) and
    // any `cause` chain. Without these, errors that propagate up through
    // catch sites lose the program-level detail that explains *why* a tx
    // simulation failed.
    const extras: Record<string, unknown> = {};
    const context = (value as { context?: unknown }).context;
    if (context !== undefined && context !== null) {
      extras.context = context;
    }
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) {
      extras.cause = cause instanceof Error ? stringifyThrownValue(cause) : cause;
    }

    if (Object.keys(extras).length === 0) {
      return value.stack
        ? value.stack
        : value.message || stackOrToString !== "[object Object]"
          ? stackOrToString
          : `could not extract error from 'Error' instance ${stackOrToString}`;
    }

    let extrasSerialized: string;
    try {
      extrasSerialized = JSON.stringify(extras);
    } catch {
      // Best-effort: if the extras can't be serialized (cyclic / exotic
      // types beyond the BigInt/Set patches in extensions.ts) fall back to
      // the stack alone so we never lose the primary diagnostic.
      return stackOrToString;
    }
    return `${stackOrToString}\n${extrasSerialized}`;
  } else if (value instanceof Object) {
    const objStringified = JSON.stringify(value);
    return objStringified !== "{}"
      ? objStringified
      : `could not extract error from 'Object' instance ${objStringified}`;
  } else {
    return `ThrownValue: ${value?.toString()}`;
  }
}
