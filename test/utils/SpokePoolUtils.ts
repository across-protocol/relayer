import { Contract, bnZero } from "../../src/utils";
import { interfaces } from "@across-protocol/sdk";
import { repaymentChainId } from "../constants";
import { SlowFillRequestWithBlock } from "../../src/interfaces";
import { SignerWithAddress } from "./utils";

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
    relayExecutionInfo: {
      updatedRecipient: deposit.updatedRecipient,
      updatedMessage: deposit.updatedMessage,
      updatedOutputAmount: deposit.updatedOutputAmount,
      fillType,
    },
  };
  return fill;
}

export async function fillV3(
  spokePool: Contract,
  relayer: SignerWithAddress,
  deposit: interfaces.V3Deposit,
  _repaymentChainId = repaymentChainId
): Promise<interfaces.V3FillWithBlock> {
  await spokePool
    .connect(relayer)
    .fillV3Relay(
      [
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
      ],
      _repaymentChainId
    );
  const [events, destinationChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.FilledV3Relay()),
    spokePool.chainId(),
  ]);
  const lastEvent = events[events.length - 1];
  const fillObject: interfaces.V3FillWithBlock = {
    inputToken: lastEvent.args?.inputToken,
    outputToken: lastEvent.args?.outputToken,
    inputAmount: lastEvent.args?.inputAmount,
    outputAmount: lastEvent.args?.outputAmount,
    originChainId: lastEvent.args?.originChainId,
    repaymentChainId: lastEvent.args?.repaymentChainId,
    relayer: lastEvent.args?.relayer,
    depositId: lastEvent.args?.depositId,
    fillDeadline: lastEvent.args?.fillDeadline,
    exclusivityDeadline: lastEvent.args?.exclusivityDeadline,
    depositor: lastEvent.args?.depositor,
    recipient: lastEvent.args?.recipient,
    exclusiveRelayer: lastEvent.args?.exclusiveRelayer,
    message: lastEvent.args?.message,
    relayExecutionInfo: {
      updatedRecipient: lastEvent.args?.updatedRecipient,
      updatedMessage: lastEvent.args?.updatedMessage,
      updatedOutputAmount: lastEvent.args?.updatedOutputAmount,
      fillType: lastEvent.args?.fillType,
    },
    destinationChainId,
    blockNumber: lastEvent.blockNumber,
    transactionHash: lastEvent.transactionHash,
    logIndex: lastEvent.logIndex,
    transactionIndex: lastEvent.transactionIndex,
  };
  return fillObject;
}

export async function requestSlowFill(
  spokePool: Contract,
  relayer: SignerWithAddress,
  deposit?: interfaces.V3Deposit
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
