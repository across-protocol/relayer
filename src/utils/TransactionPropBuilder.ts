import { BigNumber } from "../utils";
import { Deposit } from "../interfaces/SpokePool";
export function buildFillRelayProps(
  depositInfo: { unfilledAmount: BigNumber; deposit: Deposit },
  repaymentChain: number
) {
  return [
    depositInfo.deposit.depositor,
    depositInfo.deposit.recipient,
    depositInfo.deposit.destinationToken,
    depositInfo.deposit.amount, // maxTokensToSend. TODO: update this to be a prop that the caller defines.
    depositInfo.unfilledAmount,
    repaymentChain,
    depositInfo.deposit.originChainId,
    depositInfo.deposit.realizedLpFeePct,
    depositInfo.deposit.relayerFeePct,
    depositInfo.deposit.depositId,
  ];
}
