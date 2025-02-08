import { TransactionReceipt } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CONTRACT_ADDRESSES } from "../../../common";
import {
  Contract,
  EventSearchConfig,
  Signer,
  TOKEN_SYMBOLS_MAP,
  getCachedProvider,
  groupObjectCountsByProp,
  isDefined,
  paginatedEventQuery,
  winston,
  convertFromWei,
} from "../../../utils";
import { CCTPMessageStatus, DecodedCCTPMessage, resolveCCTPRelatedTxns } from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage } from "../../types";
import { uniqWith } from "lodash";
import { generateMultiCallData } from "./utils";

export async function cctpL1toL2Finalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
  l1ToL2AddressesToFinalize: string[]
): Promise<FinalizerPromise> {
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[l2SpokePoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(
    cctpMessageReceiverDetails.address,
    cctpMessageReceiverDetails.abi,
    l2SpokePoolClient.spokePool.provider
  );
  const decodedMessages = await resolveRelatedTxnReceipts(
    l1ToL2AddressesToFinalize,
    hubPoolClient.chainId,
    l2SpokePoolClient.chainId,
    l1SpokePoolClient
  );
  const unprocessedMessages = decodedMessages.filter((message) => message.status === "ready");
  const statusesGrouped = groupObjectCountsByProp(
    decodedMessages,
    (message: { status: CCTPMessageStatus }) => message.status
  );
  logger.debug({
    at: `Finalizer#CCTPL1ToL2Finalizer:${l2SpokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} ready to finalize messages for CCTP L1 to ${l2SpokePoolClient.chainId}`,
    statusesGrouped,
  });

  const callData = await generateMultiCallData(contract, unprocessedMessages, logger, l2SpokePoolClient.chainId);
  return {
    crossChainMessages: await generateDepositData(
      unprocessedMessages.filter((_message, i) => isDefined(callData[i])),
      hubPoolClient.chainId,
      l2SpokePoolClient.chainId
    ),
    callData: callData.filter((_message, i) => isDefined(callData[i])),
  };
}

async function findRelevantTxnReceiptsForCCTPDeposits(
  currentChainId: number,
  addressesToSearch: string[],
  l1SpokePoolClient: SpokePoolClient
): Promise<TransactionReceipt[]> {
  const provider = getCachedProvider(currentChainId);
  const tokenMessengerContract = new Contract(
    CONTRACT_ADDRESSES[currentChainId].cctpTokenMessenger.address,
    CONTRACT_ADDRESSES[currentChainId].cctpTokenMessenger.abi,
    provider
  );
  const eventFilter = tokenMessengerContract.filters.DepositForBurn(
    undefined,
    TOKEN_SYMBOLS_MAP.USDC.addresses[currentChainId], // Filter by only USDC token deposits
    undefined,
    addressesToSearch // All depositors that we are monitoring for
  );
  const searchConfig: EventSearchConfig = {
    fromBlock: l1SpokePoolClient.eventSearchConfig.fromBlock,
    toBlock: l1SpokePoolClient.latestBlockSearched,
    maxBlockLookBack: l1SpokePoolClient.eventSearchConfig.maxBlockLookBack,
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
  l1SpokePoolClient: SpokePoolClient
): Promise<DecodedCCTPMessage[]> {
  const allReceipts = await findRelevantTxnReceiptsForCCTPDeposits(
    currentChainId,
    addressesToSearch,
    l1SpokePoolClient
  );
  return resolveCCTPRelatedTxns(allReceipts, currentChainId, targetDestinationChainId);
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
    amount: convertFromWei(message.amount, TOKEN_SYMBOLS_MAP.USDC.decimals), // Format out to 6 decimal places for USDC
    type: "deposit",
    originationChainId,
    destinationChainId,
  }));
}
