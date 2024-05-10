/* eslint-disable @typescript-eslint/no-unused-vars */
import { TransactionRequest } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call, chainIdsToCctpDomains } from "../../../common";
import {
  Contract,
  Signer,
  getBlockForTimestamp,
  getCurrentTime,
  getNetworkName,
  getRedisCache,
  winston,
} from "../../../utils";
import { DecodedCCTPMessage, hasCCTPMessageBeenProcessed, resolveCCTPRelatedTxns } from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage } from "../../types";

export async function cctpL2toL1Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  // Let's just assume for now CCTP transfers don't take longer than 1 day and can
  // happen very quickly.
  const lookback = getCurrentTime() - 60 * 60 * 24;
  const redis = await getRedisCache(logger);
  const fromBlock = await getBlockForTimestamp(hubPoolClient.chainId, lookback, undefined, redis);
  logger.debug({
    at: `Finalizer#CCTPL2ToL1Finalizer:${spokePoolClient.chainId}`,
    message: `MessageSent event filter for ${getNetworkName(spokePoolClient.chainId)} to L1`,
    fromBlock,
  });
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[hubPoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(
    cctpMessageReceiverDetails.address,
    cctpMessageReceiverDetails.abi,
    hubPoolClient.hubPool.provider
  );
  const decodedMessages = await resolveRelatedTxnReceipts(spokePoolClient, hubPoolClient.chainId, fromBlock, contract);
  const unprocessedMessages = decodedMessages.filter((message) => !message.processed);
  logger.debug({
    at: `Finalizer#CCTPL2ToL1Finalizer:${spokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} unprocessed messages`,
    processed: decodedMessages.filter((message) => message.processed).length,
    unprocessed: unprocessedMessages.length,
  });

  return {
    crossChainMessages: await generateWithdrawalData(
      unprocessedMessages,
      spokePoolClient.chainId,
      hubPoolClient.chainId
    ),
    callData: await generateMultiCallData(contract, unprocessedMessages),
  };
}

async function resolveRelatedTxnReceipts(
  client: SpokePoolClient,
  targetDestinationChainId: number,
  latestBlockToFinalize: number,
  destinationMessageTransmitter: Contract
): Promise<(DecodedCCTPMessage & { processed: boolean })[]> {
  // Resolve the receipts to all collected txns
  const txnReceipts = await Promise.all(
    client
      .getTokensBridged()
      .filter((bridgeEvent) => bridgeEvent.blockNumber >= latestBlockToFinalize)
      .map((bridgeEvent) => client.spokePool.provider.getTransactionReceipt(bridgeEvent.transactionHash))
  );
  const decodedMessages = await resolveCCTPRelatedTxns(txnReceipts, client.chainId, targetDestinationChainId);
  const statusPromises = decodedMessages.map((message) =>
    hasCCTPMessageBeenProcessed(chainIdsToCctpDomains[client.chainId], message.nonce, destinationMessageTransmitter)
  );
  const processed = await Promise.all(statusPromises);
  return decodedMessages.map((message, index) => ({ ...message, processed: processed[index] }));
}

/**
 * Generates a series of populated transactions that can be consumed by the Multicall2 contract.
 * @param messageTransmitter The CCTPMessageTransmitter contract that will be used to populate the transactions.
 * @param messages The messages to generate transactions for.
 * @returns A list of populated transactions that can be consumed by the Multicall2 contract.
 */
async function generateMultiCallData(
  messageTransmitter: Contract,
  messages: DecodedCCTPMessage[]
): Promise<Multicall2Call[]> {
  return Promise.all(
    messages.map(async (message) => {
      const txn = (await messageTransmitter.populateTransaction.receiveMessage(
        message.messageBytes,
        message.attestation
      )) as TransactionRequest;
      return {
        target: txn.to,
        callData: txn.data,
      };
    })
  );
}

/**
 * Generates a list of valid withdrawals for a given list of CCTP messages.
 * @param messages The CCTP messages to generate withdrawals for.
 * @param originationChainId The chain that these messages originated from
 * @param destinationChainId The chain that these messages will be executed on
 * @returns A list of valid withdrawals for a given list of CCTP messages.
 */
async function generateWithdrawalData(
  messages: DecodedCCTPMessage[],
  originationChainId: number,
  destinationChainId: number
): Promise<CrossChainMessage[]> {
  return messages.map((message) => ({
    l1TokenSymbol: "USDC", // Always USDC b/c that's the only token we support on CCTP
    amount: message.amount,
    type: "withdrawal",
    originationChainId,
    destinationChainId,
  }));
}
