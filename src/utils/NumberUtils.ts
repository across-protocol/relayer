/**
 * @notice Should be used as a replacement for Number.toFixed() where the result is not rounded to the set
 * number of decimals. toFixed() automatically rounds the last digit.
 * @param number The number to truncate (i.e. 1.239)
 * @param decimals The number of decimals to truncate to (i.e. 2)
 * @returns The truncated number (i.e. 1.23)
 */
export function truncate(number: number, decimals: number): number {
  const re = new RegExp("^-?\\d+(?:.\\d{0," + (decimals || -1) + "})?");
  return Number(number.toString().match(re)[0]);
}
