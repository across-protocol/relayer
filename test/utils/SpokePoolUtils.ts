import { DepositWithBlock, Fill, FillWithBlock, RefundRequest } from "../../src/interfaces";
import { toBN } from "../../src/utils";

export function fillFromDeposit(deposit: DepositWithBlock, relayer: string): Fill {
  const { recipient, message, relayerFeePct } = deposit;

  const fill: Fill = {
    amount: deposit.amount,
    depositId: deposit.depositId,
    originChainId: deposit.originChainId,
    destinationChainId: deposit.destinationChainId,
    depositor: deposit.depositor,
    destinationToken: deposit.destinationToken,
    relayerFeePct: deposit.relayerFeePct,
    realizedLpFeePct: deposit.realizedLpFeePct,
    recipient,
    relayer,
    message,

    // Caller can modify these later.
    fillAmount: deposit.amount,
    totalFilledAmount: deposit.amount,
    repaymentChainId: deposit.destinationChainId,

    updatableRelayData: {
      recipient: deposit.updatedRecipient ?? recipient,
      message: deposit.updatedMessage ?? message,
      relayerFeePct: deposit.newRelayerFeePct ?? relayerFeePct,
      isSlowRelay: false,
      payoutAdjustmentPct: toBN(0),
    },
  };

  return fill;
}

export function refundRequestFromFill(fill: FillWithBlock, refundToken: string): RefundRequest {
  const refundRequest: RefundRequest = {
    amount: fill.amount,
    depositId: fill.depositId,
    originChainId: fill.originChainId,
    destinationChainId: fill.destinationChainId,
    repaymentChainId: fill.repaymentChainId,
    realizedLpFeePct: fill.realizedLpFeePct,
    fillBlock: toBN(fill.blockNumber),
    relayer: fill.relayer,
    refundToken,
    previousIdenticalRequests: toBN(0),
  };

  return refundRequest;
}
