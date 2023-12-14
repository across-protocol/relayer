import { Fill } from "../interfaces";
import { bnZero, fixedPointAdjustment as fixedPoint } from "./SDKUtils";
import { BigNumber } from ".";

export function _getRefundForFill(fill: Fill): BigNumber {
  return fill.fillAmount.mul(fixedPoint.sub(fill.realizedLpFeePct)).div(fixedPoint);
}

export function _getFeeAmount(fillAmount: BigNumber, feePct: BigNumber): BigNumber {
  return fillAmount.mul(feePct).div(fixedPoint);
}

export function _getRealizedLpFeeForFill(fill: Fill): BigNumber {
  return fill.fillAmount.mul(fill.realizedLpFeePct).div(fixedPoint);
}

export function getRefund(fillAmount: BigNumber, realizedLpFeePct: BigNumber): BigNumber {
  return fillAmount.mul(fixedPoint.sub(realizedLpFeePct)).div(fixedPoint);
}

export function getFillAmountMinusFees(
  fillAmount: BigNumber,
  realizedLpFeePct: BigNumber,
  relayerFeePct: BigNumber
): BigNumber {
  return fillAmount.mul(fixedPoint.sub(realizedLpFeePct).sub(relayerFeePct)).div(fixedPoint);
}

export function getRefundForFills(fills: Fill[]): BigNumber {
  return fills.reduce((acc, fill) => acc.add(_getRefundForFill(fill)), bnZero);
}

export function getRealizedLpFeeForFills(fills: Fill[]): BigNumber {
  return fills.reduce((acc, fill) => acc.add(_getRealizedLpFeeForFill(fill)), bnZero);
}
