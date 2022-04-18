import { Fill } from "../interfaces";
import { toBNWei, BigNumber, toBN } from ".";

export function _getRefundForFill(fill: Fill): BigNumber {
  return fill.fillAmount.mul(toBNWei(1).sub(fill.realizedLpFeePct)).div(toBNWei(1));
}

export function _getRealizedLpFeeForFill(fill: Fill): BigNumber {
  return fill.fillAmount.mul(fill.realizedLpFeePct).div(toBNWei(1));
}

export function getRefundForFills(fills: Fill[]): BigNumber {
  let accumulator = toBN(0);
  fills.forEach((fill) => (accumulator = accumulator.add(_getRefundForFill(fill))));
  return accumulator;
}

export function getRealizedLpFeeForFills(fills: Fill[]): BigNumber {
  let accumulator = toBN(0);
  fills.forEach((fill) => (accumulator = accumulator.add(_getRealizedLpFeeForFill(fill))));
  return accumulator;
}
