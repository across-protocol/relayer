import { BigNumber } from ".";

export function min(a: BigNumber, b: BigNumber): BigNumber {
  return a.lt(b) ? a : b;
}
