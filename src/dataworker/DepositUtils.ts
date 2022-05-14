import { DepositWithBlock, UnfilledDeposit } from "../interfaces";

export function getDepositCountGroupedByProp(deposits: DepositWithBlock[], propName: string) {
  return deposits.reduce((result, deposit: DepositWithBlock) => {
    const existingCount = result[deposit[propName]];
    result[deposit[propName]] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}

export function getUnfilledDepositCountGroupedByProp(unfilledDeposits: UnfilledDeposit[], propName: string) {
  return unfilledDeposits.reduce((result, unfilledDeposit: UnfilledDeposit) => {
    const existingCount = result[unfilledDeposit.deposit[propName]];
    result[unfilledDeposit.deposit[propName]] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}
