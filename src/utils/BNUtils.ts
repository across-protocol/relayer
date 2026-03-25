import { ConvertDecimals } from "./";
// eslint-disable-next-line no-restricted-imports
import { BigNumber } from "@ethersproject/bignumber";

// eslint-disable-next-line no-restricted-imports
export * from "@ethersproject/bignumber";

export function bnComparatorDescending(a: BigNumber, b: BigNumber): -1 | 0 | 1 {
  if (b.gt(a)) {
    return 1;
  } else if (a.gt(b)) {
    return -1;
  } else {
    return 0;
  }
}

export function bnComparatorAscending(a: BigNumber, b: BigNumber): -1 | 0 | 1 {
  if (a.gt(b)) {
    return 1;
  } else if (b.gt(a)) {
    return -1;
  } else {
    return 0;
  }
}

export function floatToBN(float: string | number, precision: number): BigNumber {
  // Convert to a fixed-point decimal string to avoid scientific notation (e.g. "1.234e-9")
  // that JavaScript produces for very small or very large numbers.
  const strFloat = typeof float === "string" ? float : float.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  const dotIndex = strFloat.indexOf(".");
  if (dotIndex === -1) {
    // No decimal point — treat as integer with 0 decimal places.
    return ConvertDecimals(0, precision)(BigNumber.from(strFloat));
  }
  // Remove the decimal point to get the scaled integer as a string, avoiding floating-point overflow
  // for numbers with many decimal digits (e.g. 5654.8610313399695 * 10^13 > Number.MAX_SAFE_INTEGER).
  const integerPart = strFloat.slice(0, dotIndex);
  const fractionalPart = strFloat.slice(dotIndex + 1);
  const adjustment = fractionalPart.length;
  const bnAmount = BigNumber.from(integerPart + fractionalPart);
  return ConvertDecimals(adjustment, precision)(bnAmount);
}
