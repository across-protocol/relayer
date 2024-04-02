/* eslint-disable @typescript-eslint/no-unused-vars */
import { TransactionRequest } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call } from "../../../common";
import {
  Contract,
  Signer,
  getBlockForTimestamp,
  getCurrentTime,
  getNetworkName,
  getRedisCache,
  winston,
} from "../../../utils";
import { DecodedCCTPMessage, resolveCCTPRelatedTxns } from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage } from "../../types";

export async function cctpL1toL2Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  // Let's just assume for now CCTP transfers don't take longer than 1 day and can
  // happen very quickly.
  const lookback = getCurrentTime() - 60 * 60 * 24;
  const redis = await getRedisCache(logger);
  const fromBlock = await getBlockForTimestamp(spokePoolClient.chainId, lookback, undefined, redis);
  logger.debug({
    at: "Finalizer#CCTPL1ToL2Finalizer",
    message: `MessageSent event filter for L1 to ${getNetworkName(spokePoolClient.chainId)}`,
    fromBlock,
  });
  const decodedMessages = await resolveRelatedTxnReceipts(hubPoolClient, spokePoolClient.chainId, fromBlock);
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[hubPoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(cctpMessageReceiverDetails.address, cctpMessageReceiverDetails.abi, signer);
  return {
    crossChainMessages: await generateDepositData(decodedMessages, hubPoolClient.chainId, spokePoolClient.chainId),
    callData: await generateMultiCallData(contract, decodedMessages),
  };
}

async function resolveRelatedTxnReceipts(
  client: HubPoolClient,
  targetDestinationChainId: number,
  latestBlockToFinalize: number
): Promise<DecodedCCTPMessage[]> {
  // Resolve the receipts to all collected txns
  const txnReceipts = await Promise.all(
    client
      .getExecutedRootBundles()
      .filter((bundle) => bundle.blockNumber >= latestBlockToFinalize)
      .map((bundle) => client.hubPool.provider.getTransactionReceipt(bundle.transactionHash))
  );
  return resolveCCTPRelatedTxns(txnReceipts, client.chainId, targetDestinationChainId);
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
async function generateDepositData(
  messages: DecodedCCTPMessage[],
  originationChainId: number,
  destinationChainId: number
): Promise<CrossChainMessage[]> {
  return messages.map((message) => ({
    l1TokenSymbol: "USDC", // Always USDC b/c that's the only token we support on CCTP
    amount: message.amount,
    type: "deposit",
    originationChainId,
    destinationChainId,
  }));
}
