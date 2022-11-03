export function isPromiseFulfulled<T>(
  promiseSettledResult: PromiseSettledResult<T>
): promiseSettledResult is PromiseFulfilledResult<T> {
  return promiseSettledResult.status === "fulfilled";
}

export function isPromiseRejected<T>(
  promiseSettledResult: PromiseSettledResult<T>
): promiseSettledResult is PromiseRejectedResult {
  return promiseSettledResult.status === "rejected";
}

export function isDefined<T>(input: T | null | undefined): input is T {
  return input !== null && input !== undefined;
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
