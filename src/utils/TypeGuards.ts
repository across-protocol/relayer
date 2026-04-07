import { utils } from "@across-protocol/sdk";

export const { isDefined, isPromiseFulfilled, isPromiseRejected } = utils;

/**
 * Parse a JSON string expected to contain a string array. Throws if the result is not a string[].
 */
export function parseJsonStringArray(json: string | undefined, fallback = "[]"): string[] {
  const parsed: unknown = JSON.parse(json ?? fallback);
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
    throw new Error(`Expected string[], got: ${json}`);
  }
  return parsed;
}

/**
 * Parse a JSON string expected to contain a number array. Throws if the result is not a number[].
 */
export function parseJsonNumberArray(json: string | undefined, fallback = "[]"): number[] {
  const parsed: unknown = JSON.parse(json ?? fallback);
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "number")) {
    throw new Error(`Expected number[], got: ${json}`);
  }
  return parsed;
}

// This function allows you to test for the key type in an object literal.
// For instance, this would compile in typescript strict:
//   const myObj = { a: 1, b: 2, c: 3 } as const;
//   const d: string = "a";
//   const myNumber = isKeyOf(d, myObj) ? myObj[d] : 4;
export function isKeyOf<T extends V, V extends number | string | symbol>(
  input: V,
  obj: Record<T, unknown>
): input is T {
  return input in obj;
}
