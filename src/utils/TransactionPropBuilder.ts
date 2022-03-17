import { BigNumber } from "../utils";
import { Deposit } from "../interfaces/SpokePool";
export function buildFillRelayProps(
  depositInfo: { unfilledAmount: BigNumber; deposit: Deposit },
  destinationToken: string,
  repaymentChain: number,
  realizedLpFeePct: BigNumber
) {
  return [
    depositInfo.deposit.depositor,
    depositInfo.deposit.recipient,
    destinationToken,
    depositInfo.deposit.amount, // maxTokensToSend. TODO: update this to be a prop that the caller defines.
    depositInfo.unfilledAmount,
    repaymentChain,
    depositInfo.deposit.originChainId,
    realizedLpFeePct,
    depositInfo.deposit.relayerFeePct,
    depositInfo.deposit.depositId,
  ];
}
