import assert from "assert";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { BigNumber, BigNumberish, MAX_UINT_VAL } from "../utils";
import { Deposit } from "../interfaces";
export function buildFillRelayProps(
  deposit: Deposit,
  repaymentChainId: number,
  maxFillAmount: BigNumber
): (string | number | BigNumber)[] {
  assert(sdkUtils.isV2Deposit(deposit));

  // Validate all keys are present.
  for (const key in deposit) {
    if (deposit[key] == undefined) {
      throw new Error(`Missing or undefined value in props! ${key}`);
    }
  }

  return [
    deposit.depositor,
    deposit.recipient,
    deposit.destinationToken,
    deposit.amount,
    maxFillAmount,
    repaymentChainId,
    deposit.originChainId,
    deposit.realizedLpFeePct,
    deposit.relayerFeePct,
    deposit.depositId,
    deposit.message,
    BigNumber.from(MAX_UINT_VAL),
  ];
}

export function buildFillRelayWithUpdatedFeeProps(
  deposit: Deposit,
  repaymentChainId: number,
  maxFillAmount: BigNumber
): BigNumberish[] {
  assert(sdkUtils.isV2Deposit(deposit));

  // Validate all keys are present.
  for (const key in deposit) {
    if (deposit[key] == undefined) {
      throw new Error(`Missing or undefined value in props! ${key}`);
    }
  }

  return [
    deposit.depositor,
    deposit.recipient,
    deposit.updatedRecipient,
    deposit.destinationToken,
    deposit.amount,
    maxFillAmount,
    repaymentChainId,
    deposit.originChainId,
    deposit.realizedLpFeePct,
    deposit.relayerFeePct,
    deposit.newRelayerFeePct,
    deposit.depositId,
    deposit.message,
    deposit.updatedMessage,
    deposit.speedUpSignature,
    BigNumber.from(MAX_UINT_VAL),
  ];
}
