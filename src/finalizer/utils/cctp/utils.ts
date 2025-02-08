import { TransactionRequest } from "@ethersproject/abstract-provider";
import { Contract, assert, isDefined, Multicall2Call, winston } from "../../../utils";
import { DecodedCCTPMessage } from "../../../utils/CCTPUtils";

/**
 * Generates a series of populated transactions that can be consumed by the Multicall2 contract.
 * @param messageTransmitter The CCTPMessageTransmitter contract that will be used to populate the transactions.
 * @param messages The messages to generate transactions for.
 * @returns A list of populated transactions that can be consumed by the Multicall2 contract. If any message
 * fails to simulate, it will be undefined.
 */
export async function generateMultiCallData(
  messageTransmitter: Contract,
  messages: DecodedCCTPMessage[],
  logger: winston.Logger,
  l2ChainId
): Promise<(Multicall2Call | undefined)[]> {
  assert(messages.every((message) => isDefined(message.attestation)));
  return Promise.all(
    messages.map(async (message) => {
      try {
        await messageTransmitter.estimateGas.receiveMessage(message.messageBytes, message.attestation);
        // Try to simulate transaction to give more detailed error log if it would fail in the multicaller.
        const txn = (await messageTransmitter.populateTransaction.receiveMessage(
          message.messageBytes,
          message.attestation
        )) as TransactionRequest;
        return {
          target: txn.to,
          callData: txn.data,
        };
      } catch (error) {
        logger.warn({
          at: `Finalizer#CCTPFinalizer:${l2ChainId}:generateMultiCallData`,
          message: "Finalizing CCTP transfer failed simulation",
          l2ChainId,
          target: messageTransmitter.address,
          method: "receiveMessage",
          args: [message.messageBytes, message.attestation],
          error,
        });
        return undefined;
      }
    })
  );
}
