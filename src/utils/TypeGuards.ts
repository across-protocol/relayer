import { utils } from "@across-protocol/sdk-v2";
import * as superstruct from "superstruct";
import { ProviderErrorCount } from "./RedisUtils";

export const { isDefined, isPromiseFulfilled, isPromiseRejected } = utils;

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

const providerErrorCountSchema = superstruct.object({
  chainId: superstruct.integer(),
  provider: superstruct.string(),
  errorCount: superstruct.min(superstruct.number(), 0),
  lastTime: superstruct.min(superstruct.integer(), 0),
});

export function isProviderErrorCount(input: unknown): input is ProviderErrorCount {
  return providerErrorCountSchema.is(input);
}
