/* eslint-disable @typescript-eslint/no-unused-vars */
import { TransactionReceipt, TransactionRequest } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CHAIN_MAX_BLOCK_LOOKBACK, CONTRACT_ADDRESSES, Multicall2Call } from "../../../common";
import {
  Contract,
  EventSearchConfig,
  Signer,
  getBlockForTimestamp,
  getCachedProvider,
  getCurrentTime,
  getNetworkName,
  getProvider,
  getRedisCache,
  paginatedEventQuery,
  winston,
} from "../../../utils";
import { DecodedCCTPMessage, resolveCCTPRelatedTxns } from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage } from "../../types";
import { getBlockRangeByHoursOffsets } from "../linea/common";
import { uniqWith } from "lodash";

export async function cctpL1toL2Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  l1ToL2AddressesToFinalize: string[]
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
  const decodedMessages = await resolveRelatedTxnReceipts(
    l1ToL2AddressesToFinalize,
    hubPoolClient.chainId,
    spokePoolClient.chainId,
    fromBlock
  );
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[spokePoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(cctpMessageReceiverDetails.address, cctpMessageReceiverDetails.abi, signer);
  return {
    crossChainMessages: await generateDepositData(decodedMessages, hubPoolClient.chainId, spokePoolClient.chainId),
    callData: await generateMultiCallData(contract, decodedMessages),
  };
}

async function findRelevantTxnReceiptsForCCTPDeposits(
  currentChainId: number,
  addressesToSearch: string[]
): Promise<TransactionReceipt[]> {
  const provider = getCachedProvider(currentChainId);
  const tokenMessengerContract = new Contract(
    CONTRACT_ADDRESSES[currentChainId].cctpTokenMessenger.address,
    CONTRACT_ADDRESSES[currentChainId].cctpTokenMessenger.abi,
    provider
  );
  const eventFilter = tokenMessengerContract.filters.DepositForBurn(
    undefined,
    undefined, // This should be the UDSC address, but we are currently blocked
    undefined,
    addressesToSearch // All depositors that we are monitoring for
  );
  const { fromBlock, toBlock } = await getBlockRangeByHoursOffsets(currentChainId, 24, 0);
  const searchConfig: EventSearchConfig = {
    fromBlock,
    toBlock,
    maxBlockLookBack: CHAIN_MAX_BLOCK_LOOKBACK[currentChainId] || 10_000,
  };
  const events = await paginatedEventQuery(tokenMessengerContract, eventFilter, searchConfig);
  const receipts = await Promise.all(events.map((event) => provider.getTransactionReceipt(event.transactionHash)));
  // Return the receipts, without duplicated transaction hashes
  return uniqWith(receipts, (a, b) => a.transactionHash.toLowerCase() === b.transactionHash.toLowerCase());
}

async function resolveRelatedTxnReceipts(
  addressesToSearch: string[],
  currentChainId: number,
  targetDestinationChainId: number,
  latestBlockToFinalize: number
): Promise<DecodedCCTPMessage[]> {
  const txnReceipts = (await findRelevantTxnReceiptsForCCTPDeposits(currentChainId, addressesToSearch)).filter(
    (receipt) => receipt.blockNumber >= latestBlockToFinalize
  );
  return resolveCCTPRelatedTxns(txnReceipts, currentChainId, targetDestinationChainId);
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
