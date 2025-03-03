import { Contract, bnZero, spreadEvent, toBytes32 } from "../../src/utils";
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
    .requestSlowFill([
      toBytes32(deposit.depositor),
      toBytes32(deposit.recipient),
      toBytes32(deposit.exclusiveRelayer),
      toBytes32(deposit.inputToken),
      toBytes32(deposit.outputToken),
      deposit.inputAmount,
      deposit.outputAmount,
      deposit.originChainId,
      deposit.depositId,
      deposit.fillDeadline,
      deposit.exclusivityDeadline,
      deposit.message,
    ]);
  const [events, destinationChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.RequestedSlowFill()),
    spokePool.chainId(),
  ]);
  const lastEvent = events[events.length - 1];
  const requestObject: interfaces.SlowFillRequestWithBlock = {
    destinationChainId,
    blockNumber: lastEvent.blockNumber,
    transactionHash: lastEvent.transactionHash,
    logIndex: lastEvent.logIndex,
    transactionIndex: lastEvent.transactionIndex,
    ...spreadEvent(lastEvent.args!),
  };
  return requestObject;
}
