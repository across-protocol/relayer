import { array, create, number, record, string } from "superstruct";
import { utils } from "@across-protocol/sdk";

export const { isDefined, isPromiseFulfilled, isPromiseRejected } = utils;

/**
 * Parse a JSON string expected to contain a string array. Throws if the result is not a string[].
 */
export function parseJsonStringArray(json: string | undefined, fallback = "[]"): string[] {
  return create(JSON.parse(json ?? fallback), array(string()));
}

/**
 * Parse a JSON string expected to contain an object mapping string keys to string arrays.
 * Throws if the result is not a Record<string, string[]>.
 */
export function parseJsonStringArrayMap(json: string | undefined, fallback = "{}"): Record<string, string[]> {
  return create(JSON.parse(json ?? fallback), record(string(), array(string())));
}

/**
 * Parse a JSON string expected to contain a number array. Throws if the result is not a number[].
 */
export function parseJsonNumberArray(json: string | undefined, fallback = "[]"): number[] {
  return create(JSON.parse(json ?? fallback), array(number()));
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
