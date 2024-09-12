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
