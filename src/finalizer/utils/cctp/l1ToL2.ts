/* eslint-disable @typescript-eslint/no-unused-vars */
import { TransactionReceipt, TransactionRequest } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CHAIN_MAX_BLOCK_LOOKBACK, CONTRACT_ADDRESSES, Multicall2Call, chainIdsToCctpDomains } from "../../../common";
import {
  Contract,
  EventSearchConfig,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  formatUnitsForToken,
  getBlockForTimestamp,
  getCachedProvider,
  getCurrentTime,
  getNetworkName,
  getRedisCache,
  groupObjectCountsByProp,
  isDefined,
  paginatedEventQuery,
  winston,
} from "../../../utils";
import { CCTPMessageStatus, DecodedCCTPMessage, resolveCCTPRelatedTxns } from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage } from "../../types";
import { getBlockRangeByHoursOffsets } from "../linea/common";
import { groupBy, uniqWith } from "lodash";

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
  const fromBlock = await getBlockForTimestamp(hubPoolClient.chainId, lookback, undefined, redis);
  logger.debug({
    at: `Finalizer#CCTPL1ToL2Finalizer:${spokePoolClient.chainId}`,
    message: `MessageSent event filter for L1 to ${getNetworkName(spokePoolClient.chainId)}`,
    fromBlock,
  });
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[spokePoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(
    cctpMessageReceiverDetails.address,
    cctpMessageReceiverDetails.abi,
    spokePoolClient.spokePool.provider
  );
  const decodedMessages = await resolveRelatedTxnReceipts(
    l1ToL2AddressesToFinalize,
    hubPoolClient.chainId,
    spokePoolClient.chainId,
    fromBlock
  );
  const unprocessedMessages = decodedMessages.filter((message) => message.status === "ready");
  const statusesGrouped = groupObjectCountsByProp(
    decodedMessages,
    (message: { status: CCTPMessageStatus }) => message.status
  );
  logger.debug({
    at: `Finalizer#CCTPL1ToL2Finalizer:${spokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} ready to finalize messages`,
    statusesGrouped,
  });

  return {
    crossChainMessages: await generateDepositData(unprocessedMessages, hubPoolClient.chainId, spokePoolClient.chainId),
    callData: await generateMultiCallData(contract, unprocessedMessages),
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
    TOKEN_SYMBOLS_MAP._USDC.addresses[currentChainId], // Filter by only USDC token deposits
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
  const allReceipts = await findRelevantTxnReceiptsForCCTPDeposits(currentChainId, addressesToSearch);
  const filteredReceipts = allReceipts.filter((receipt) => receipt.blockNumber >= latestBlockToFinalize);
  return resolveCCTPRelatedTxns(filteredReceipts, currentChainId, targetDestinationChainId);
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
  assert(messages.every((message) => isDefined(message.attestation)));
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
    amount: formatUnitsForToken("USDC", message.amount), // Format out to 6 decimal places for USDC
    type: "deposit",
    originationChainId,
    destinationChainId,
  }));
}
