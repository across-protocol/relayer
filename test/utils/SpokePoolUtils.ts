import { Contract, bnZero } from "../../src/utils";
import { interfaces } from "@across-protocol/sdk";
import { SlowFillRequestWithBlock } from "../../src/interfaces";
import { SignerWithAddress } from "./utils";

export function V3FillFromDeposit(
  deposit: interfaces.DepositWithBlock,
  relayer: string,
  repaymentChainId?: number,
  fillType = interfaces.FillType.FastFill
): interfaces.Fill {
  const { blockNumber, transactionHash, logIndex, transactionIndex, quoteTimestamp, ...relayData } = deposit;
  const fill: interfaces.Fill = {
    ...relayData,
    relayer,
    realizedLpFeePct: deposit.realizedLpFeePct ?? bnZero,
    repaymentChainId: repaymentChainId ?? deposit.destinationChainId,
    relayExecutionInfo: {
      updatedRecipient: deposit.updatedRecipient,
      updatedMessage: deposit.updatedMessage,
      updatedOutputAmount: deposit.updatedOutputAmount,
      fillType,
    },
  };
  return fill;
}

export async function requestSlowFill(
  spokePool: Contract,
  relayer: SignerWithAddress,
  deposit?: interfaces.Deposit
): Promise<SlowFillRequestWithBlock> {
  await spokePool
    .connect(relayer)
    .requestV3SlowFill([
      deposit.depositor,
      deposit.recipient,
      deposit.exclusiveRelayer,
      deposit.inputToken,
      deposit.outputToken,
      deposit.inputAmount,
      deposit.outputAmount,
      deposit.originChainId,
      deposit.depositId,
      deposit.fillDeadline,
      deposit.exclusivityDeadline,
      deposit.message,
    ]);
  const [events, destinationChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.RequestedV3SlowFill()),
    spokePool.chainId(),
  ]);
  const lastEvent = events[events.length - 1];
  const requestObject: interfaces.SlowFillRequestWithBlock = {
    inputToken: lastEvent.args?.inputToken,
    outputToken: lastEvent.args?.outputToken,
    inputAmount: lastEvent.args?.inputAmount,
    outputAmount: lastEvent.args?.outputAmount,
    originChainId: lastEvent.args?.originChainId,
    depositId: lastEvent.args?.depositId,
    fillDeadline: lastEvent.args?.fillDeadline,
    exclusivityDeadline: lastEvent.args?.exclusivityDeadline,
    depositor: lastEvent.args?.depositor,
    recipient: lastEvent.args?.recipient,
    exclusiveRelayer: lastEvent.args?.exclusiveRelayer,
    message: lastEvent.args?.message,
    destinationChainId,
    blockNumber: lastEvent.blockNumber,
    transactionHash: lastEvent.transactionHash,
    logIndex: lastEvent.logIndex,
    transactionIndex: lastEvent.transactionIndex,
  };
  return requestObject;
}
