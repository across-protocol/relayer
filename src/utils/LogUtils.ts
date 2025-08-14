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
    return `ThrownValue: ${value.toString()}`;
  }
}
