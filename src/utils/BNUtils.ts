// eslint-disable-next-line no-restricted-imports
import { BigNumber } from "@ethersproject/bignumber";

// eslint-disable-next-line no-restricted-imports
export * from "@ethersproject/bignumber";

// Matches plain decimals and scientific notation such as:
//   "123", "123.45", ".5", "1e-6", "-1.23E+4"
const DECIMAL_NUMBER_REGEX = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i;

export function bnComparatorDescending(a: BigNumber, b: BigNumber): -1 | 0 | 1 {
  if (b.gt(a)) {
    return 1;
  } else if (a.gt(b)) {
    return -1;
  } else {
    return 0;
  }
}

export function floatToBN(float: string | number, precision: number): BigNumber {
  // Always parse from the rendered string form so we never depend on JS float
  // multiplication or toFixed(), both of which lose information for edge cases.
  const match = `${float}`.trim().match(DECIMAL_NUMBER_REGEX);
  if (!match) {
    throw new Error(`Invalid decimal value: ${float}`);
  }

  const [, sign = "", integerPart = "", fractionalPartFromInteger = "", fractionalPartOnly = "", exponent = "0"] =
    match;
  const fractionalPart = fractionalPartFromInteger || fractionalPartOnly;

  // Build the significand by removing the decimal point, then strip leading
  // zeros so BigNumber sees the smallest valid integer representation.
  const digits = `${integerPart || "0"}${fractionalPart}`.replace(/^0+/, "") || "0";

  if (digits === "0") {
    return BigNumber.from(0);
  }

  // `fractionalPart.length` is the number of decimal places in the significand.
  // Subtracting the exponent gives the effective source precision. From there:
  // - positive `zeroCount` means pad with zeros to reach the target precision
  // - negative `zeroCount` means truncate extra fractional digits
  const zeroCount = precision - (fractionalPart.length - Number(exponent));
  const scaledDigits =
    zeroCount >= 0 ? digits + "0".repeat(zeroCount) : digits.slice(0, Math.max(0, digits.length + zeroCount)) || "0";

  return BigNumber.from(sign === "-" && scaledDigits !== "0" ? `-${scaledDigits}` : scaledDigits);
}
