import { BigNumber } from "ethers";

export function bnComparatorDescending(a: BigNumber, b: BigNumber) {
  if (b.gt(a)) {
    return 1;
  } else if (a.gt(b)) {
    return -1;
  } else {
    return 0;
  }
}

export function bnComparatorAscending(a: BigNumber, b: BigNumber) {
  if (a.gt(b)) {
    return 1;
  } else if (b.gt(a)) {
    return -1;
  } else {
    return 0;
  }
}
