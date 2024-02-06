import { Fill, FillWithBlock, V2DepositWithBlock, V2Fill } from "../../src/interfaces";
import { bnZero, toBN } from "../../src/utils";
import { interfaces } from "@across-protocol/sdk-v2";

export function fillFromDeposit(deposit: V2DepositWithBlock, relayer: string): V2Fill {
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

export function V3FillFromDeposit(
  deposit: interfaces.V3DepositWithBlock,
  relayer: string,
  repaymentChainId?: number,
  fillType = interfaces.FillType.FastFill
): interfaces.V3Fill {
  const { blockNumber, transactionHash, logIndex, transactionIndex, quoteTimestamp, ...relayData } = deposit;
  const fill: interfaces.V3Fill = {
    ...relayData,
    relayer,
    realizedLpFeePct: deposit.realizedLpFeePct ?? bnZero,
    repaymentChainId: repaymentChainId ?? deposit.destinationChainId,
    updatableRelayData: {
      recipient: deposit.updatedRecipient,
      message: deposit.updatedMessage,
      outputAmount: deposit.updatedOutputAmount,
      fillType,
    },
  };
  return fill;
}

export function v2FillFromDeposit(deposit: V2DepositWithBlock, relayer: string, repaymentChainId?: number): V2Fill {
  const { recipient, message, relayerFeePct } = deposit;

  const fill: Fill = {
    amount: deposit.amount,
    depositId: deposit.depositId,
    originChainId: deposit.originChainId,
    destinationChainId: deposit.destinationChainId,
    depositor: deposit.depositor,
    destinationToken: deposit.destinationToken,
    relayerFeePct: deposit.relayerFeePct,
    realizedLpFeePct: deposit.realizedLpFeePct ?? bnZero,
    recipient,
    relayer,
    message,

    // Caller can modify these later.
    fillAmount: deposit.amount,
    totalFilledAmount: deposit.amount,
    repaymentChainId: repaymentChainId ?? deposit.destinationChainId,

    updatableRelayData: {
      recipient: deposit.updatedRecipient ?? recipient,
      message: deposit.updatedMessage ?? message,
      relayerFeePct: deposit.newRelayerFeePct ?? relayerFeePct,
      isSlowRelay: false,
      payoutAdjustmentPct: bnZero,
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
