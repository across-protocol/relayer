import { BigNumber } from ".";

export function max(a: BigNumber, b: BigNumber): BigNumber {
  return a.gt(b) ? a : b;
}
