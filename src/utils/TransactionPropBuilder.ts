import { BigNumber } from "../utils";
import { Deposit } from "../interfaces/SpokePool";
export function buildFillRelayProps(
  deposit: Deposit,
  repaymentChainId: number,
  maxFillAmount: BigNumber
): (string | number | BigNumber)[] {
  // Validate all keys are present.
  for (const key in deposit)
    if (deposit[key] == undefined) throw new Error(`Missing or undefined value in props! ${key}`);

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
  ];
}

export function buildFillRelayWithUpdatedFeeProps(
  deposit: Deposit,
  repaymentChainId: number,
  maxFillAmount: BigNumber
): (string | number | BigNumber)[] {
  // Validate all keys are present.
  for (const key in deposit)
    if (deposit[key] == undefined) throw new Error(`Missing or undefined value in props! ${key}`);

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
    deposit.newRelayerFeePct,
    deposit.depositId,
    deposit.speedUpSignature,
  ];
}
