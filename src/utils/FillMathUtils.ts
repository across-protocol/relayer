import { Fill } from "../interfaces";
import { BigNumber } from ".";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
const { toBN, toBNWei } = sdkUtils;

export function _getRefundForFill(fill: Fill): BigNumber {
  return fill.fillAmount.mul(toBNWei(1).sub(fill.realizedLpFeePct)).div(toBNWei(1));
}

export function _getFeeAmount(fillAmount: BigNumber, feePct: BigNumber): BigNumber {
  return fillAmount.mul(feePct).div(toBNWei(1));
}

export function _getRealizedLpFeeForFill(fill: Fill): BigNumber {
  return fill.fillAmount.mul(fill.realizedLpFeePct).div(toBNWei(1));
}

export function getRefund(fillAmount: BigNumber, realizedLpFeePct: BigNumber): BigNumber {
  return fillAmount.mul(toBNWei(1).sub(realizedLpFeePct)).div(toBNWei(1));
}

export function getFillAmountMinusFees(
  fillAmount: BigNumber,
  realizedLpFeePct: BigNumber,
  relayerFeePct: BigNumber
): BigNumber {
  return fillAmount.mul(toBNWei(1).sub(realizedLpFeePct).sub(relayerFeePct)).div(toBNWei(1));
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
