export type DefaultLogLevels = "debug" | "info" | "warn" | "error";

import { LogEntry } from "winston";

import { Address } from "./SDKUtils";

export function stringifyThrownValue(value: unknown): string {
  if (value instanceof Error) {
    const errToString = value.toString();
    return value.stack
      ? value.stack
      : value.message || errToString !== "[object Object]"
      ? errToString
      : "could not extract error from 'Error' instance";
  } else if (value instanceof Object) {
    const objStringified = JSON.stringify(value);
    return objStringified !== "{}" ? objStringified : "could not extract error from 'Object' instance";
  } else {
    return `ThrownValue: ${value.toString()}`;
  }
}

// Iterate over each element in the log and see if it is a address. if it is, then try casting it to a string to
// make it more readable. If something goes wrong in parsing the object (it's too large or something else) then simply
// return the original log entry without modifying it.
export function addressFormatter(logEntry: LogEntry) {
  type SymbolRecord = Record<string | symbol, any>;
  try {
    // Out is the original object if and only if one or more BigNumbers were replaced.
    const out: SymbolRecord = iterativelyReplaceAddresses(logEntry);

    // Because winston depends on some non-enumerable symbol properties, we explicitly copy those over, as they are not
    // handled in iterativelyReplaceAddresses. This only needs to happen if logEntry is being replaced.
    if (out !== logEntry)
      Object.getOwnPropertySymbols(logEntry).map((symbol) => (out[symbol] = (logEntry as SymbolRecord)[symbol]));
    return out as LogEntry;
  } catch (_) {
    return logEntry;
  }
}

// Traverse a potentially nested object and replace any element that is an Address
// with the string version of it for easy logging.
const iterativelyReplaceAddresses = (obj: Record<string | symbol, any>) => {
  // This does a DFS, recursively calling this function to find the desired value for each key.
  // It doesn't modify the original object. Instead, it creates an array of keys and updated values.
  const replacements = Object.entries(obj).map(([key, value]): [string, any] => {
    if (Address.isAddress(value)) return [key, value.toString()];
    else if (typeof value === "object" && value !== null) return [key, iterativelyReplaceAddresses(value)];
    else return [key, value];
  });

  // This will catch any values that were changed by value _or_ by reference.
  // If no changes were detected, no copy is needed and it is fine to discard the copy and return the original object.
  const copyNeeded = replacements.some(([key, value]) => obj[key] !== value);

  // Only copy if something changed. Otherwise, return the original object.
  return copyNeeded ? Object.fromEntries(replacements) : obj;
};
