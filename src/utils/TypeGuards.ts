import { array, create, number, record, string, union } from "superstruct";
import { utils } from "@across-protocol/sdk";

export const { isDefined, isPromiseFulfilled, isPromiseRejected } = utils;

/**
 * Typed JSON.parse helpers. Validates the parsed result against a superstruct schema
 * and returns the correctly-typed value. Throws on validation failure.
 *
 * Usage:
 *   parseJson.stringArray(env.FOO)
 *   parseJson.numberArray(env.BAR)
 *   parseJson.stringArrayMap(env.BAZ)
 *   parseJson.stringMap(env.QUX)
 *   parseJson.numberMap(env.QUUX)
 *   parseJson.numericMap(env.CORGE)
 */
export const parseJson = {
  /** Parse a JSON string expected to contain a string[]. */
  stringArray(json = "[]"): string[] {
    return create(JSON.parse(json), array(string()));
  },
  /** Parse a JSON string expected to contain a number[]. */
  numberArray(json = "[]"): number[] {
    return create(JSON.parse(json), array(number()));
  },
  /** Parse a JSON string expected to contain a Record<string, string>. */
  stringMap(json = "{}"): Record<string, string> {
    return create(JSON.parse(json), record(string(), string()));
  },
  /** Parse a JSON string expected to contain a Record<string, number>. */
  numberMap(json = "{}"): Record<string, number> {
    return create(JSON.parse(json), record(string(), number()));
  },
  /** Parse a JSON string expected to contain a Record<string, string | number>. */
  numericMap(json = "{}"): Record<string, string | number> {
    return create(JSON.parse(json), record(string(), union([string(), number()])));
  },
  /** Parse a JSON string expected to contain a Record<string, string[]>. */
  stringArrayMap(json = "{}"): Record<string, string[]> {
    return create(JSON.parse(json), record(string(), array(string())));
  },
};

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
