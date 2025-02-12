import { TransactionRequest } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CONTRACT_ADDRESSES } from "../../../common";
import {
  Contract,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  compareAddressesSimple,
  groupObjectCountsByProp,
  Multicall2Call,
  isDefined,
  winston,
  convertFromWei,
} from "../../../utils";
import { CCTPMessageStatus, DecodedCCTPMessage, resolveCCTPRelatedTxns } from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage } from "../../types";

export async function cctpL2toL1Finalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[hubPoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(
    cctpMessageReceiverDetails.address,
    cctpMessageReceiverDetails.abi,
    hubPoolClient.hubPool.provider
  );
  const decodedMessages = await resolveRelatedTxnReceipts(spokePoolClient, hubPoolClient.chainId);
  const unprocessedMessages = decodedMessages.filter((message) => message.status === "ready");
  const statusesGrouped = groupObjectCountsByProp(
    decodedMessages,
    (message: { status: CCTPMessageStatus }) => message.status
  );
  logger.debug({
    at: `Finalizer#CCTPL2ToL1Finalizer:${spokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} ready to finalize messages for CCTP ${spokePoolClient.chainId} to L1`,
    statusesGrouped,
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
  targetDestinationChainId: number
): Promise<DecodedCCTPMessage[]> {
  const sourceChainId = client.chainId;
  // Dedup the txnReceipt list because there might be multiple tokens bridged events in the same txn hash.

  const uniqueTxnHashes = new Set<string>();
  client
    .getTokensBridged()
    .filter((bridgeEvent) =>
      compareAddressesSimple(bridgeEvent.l2TokenAddress, TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId])
    )
    .forEach((bridgeEvent) => uniqueTxnHashes.add(bridgeEvent.transactionHash));

  // Resolve the receipts to all collected txns
  const txnReceipts = await Promise.all(
    Array.from(uniqueTxnHashes).map((hash) => client.spokePool.provider.getTransactionReceipt(hash))
  );

  return resolveCCTPRelatedTxns(txnReceipts, sourceChainId, targetDestinationChainId);
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
async function generateWithdrawalData(
  messages: DecodedCCTPMessage[],
  originationChainId: number,
  destinationChainId: number
): Promise<CrossChainMessage[]> {
  return messages.map((message) => ({
    l1TokenSymbol: "USDC", // Always USDC b/c that's the only token we support on CCTP
    amount: convertFromWei(message.amount, TOKEN_SYMBOLS_MAP.USDC.decimals),
    type: "withdrawal",
    originationChainId,
    destinationChainId,
  }));
}
