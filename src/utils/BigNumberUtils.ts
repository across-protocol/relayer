import { BigNumber } from ".";

export function max(a: BigNumber, b: BigNumber): BigNumber {
  return a.gt(b) ? a : b;
}

export function min(a: BigNumber, b: BigNumber): BigNumber {
  return a.gt(b) ? b : a;
}
