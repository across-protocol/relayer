import { bnZero } from "../../src/utils";
import { interfaces } from "@across-protocol/sdk-v2";

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
