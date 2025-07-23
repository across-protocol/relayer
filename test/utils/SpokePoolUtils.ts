import assert from "assert";
import { Contract, bnZero, spreadEvent, toAddressType } from "../../src/utils";
import { Deposit, DepositWithBlock, Fill, FillType, SlowFillRequestWithBlock } from "../../src/interfaces";
import { SignerWithAddress, slowFillRequestFromArgs } from "./utils";

export function V3FillFromDeposit(
  deposit: DepositWithBlock,
  relayer: string,
  repaymentChainId?: number,
  fillType = FillType.FastFill
): Fill {
  const { blockNumber, txnRef, logIndex, txnIndex, quoteTimestamp, ...relayData } = deposit;
  const fill: Fill = {
    ...relayData,
    relayer: toAddressType(relayer, deposit.destinationChainId),
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
  deposit: Deposit
): Promise<SlowFillRequestWithBlock> {
  await spokePool
    .connect(relayer)
    .requestSlowFill([
      deposit.depositor.toBytes32(),
      deposit.recipient.toBytes32(),
      deposit.exclusiveRelayer.toBytes32(),
      deposit.inputToken.toBytes32(),
      deposit.outputToken.toBytes32(),
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
  const lastEvent = events.at(-1);
  assert(lastEvent);
  const slowFillRequest = slowFillRequestFromArgs(spreadEvent(lastEvent.args!));
  const requestObject: SlowFillRequestWithBlock = {
    ...slowFillRequest,
    destinationChainId,
    blockNumber: lastEvent.blockNumber,
    txnRef: lastEvent.transactionHash,
    logIndex: lastEvent.logIndex,
    txnIndex: lastEvent.transactionIndex,
  };
  return requestObject;
}
