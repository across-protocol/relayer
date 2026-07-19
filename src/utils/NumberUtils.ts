import { BigNumberish } from "./BNUtils";
import { formatUnits } from "./SDKUtils";

/**
 * @notice Should be used as a replacement for Number.toFixed() where the result is not rounded to the set
 * number of decimals. toFixed() automatically rounds the last digit.
 * @param number The number to truncate (i.e. 1.239)
 * @param decimals The number of decimals to truncate to (i.e. 2)
 * @returns The truncated number (i.e. 1.23)
 */
export function truncate(number: number, decimals: number): number {
  if (!Number.isFinite(number)) {
    return number;
  }
  const [integer, fractional = ""] = number
    .toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 21 })
    .split(".");
  return Number(`${integer}.${fractional.slice(0, Math.max(0, Math.trunc(decimals)))}`) || 0;
}

/**
 * @notice Formats a raw token amount to a fixed number of decimal places (truncated, comma-grouped).
 * Unlike createFormatFunction, every value gets the same precision, so columns of values line up.
 * @param amount The raw amount in the token's smallest unit (e.g. wei).
 * @param decimals The token's decimals, used to scale the raw amount.
 * @param displayDecimals The exact number of decimal places to render.
 * @returns The formatted amount (e.g. "69,539.59").
 */
export function formatFixedDecimals(amount: BigNumberish, decimals: number, displayDecimals: number): string {
  const [integer, fraction = ""] = formatUnits(amount, decimals).split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return displayDecimals > 0
    ? `${grouped}.${fraction.padEnd(displayDecimals, "0").slice(0, displayDecimals)}`
    : grouped;
}

/**
 * @notice Builds a padding function that aligns pre-formatted numeric strings on the decimal point.
 * Values without a decimal point (e.g. integer-only or placeholder values) are right-aligned to the integer column.
 * @param values Every value that will share the column, used to compute the fixed widths.
 * @returns A function padding any of those values to the common width (all outputs are equal length).
 */
export function createDecimalAligner(values: string[]): (value: string) => string {
  const integerWidth = Math.max(0, ...values.map((value) => value.split(".")[0].length));
  const fractionWidth = Math.max(0, ...values.map((value) => value.split(".")[1]?.length ?? 0));
  return (value: string): string => {
    const [integer, fraction = ""] = value.split(".");
    const alignedFraction = (fraction.length > 0 ? `.${fraction}` : "").padEnd(
      fractionWidth > 0 ? fractionWidth + 1 : 0
    );
    return `${integer.padStart(integerWidth)}${alignedFraction}`;
  };
}
