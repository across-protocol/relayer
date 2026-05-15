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
