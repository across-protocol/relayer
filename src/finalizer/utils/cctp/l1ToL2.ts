import { TransactionRequest } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import {
  Contract,
  EventSearchConfig,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  groupObjectCountsByProp,
  isDefined,
  Multicall2Call,
  winston,
  convertFromWei,
} from "../../../utils";
import {
  AttestedCCTPDepositEvent,
  CCTPMessageStatus,
  getAttestationsForCCTPDepositEvents,
  getCctpMessageTransmitter,
} from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage } from "../../types";

export async function cctpL1toL2Finalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
  senderAddresses: string[]
): Promise<FinalizerPromise> {
  const searchConfig: EventSearchConfig = {
    fromBlock: l1SpokePoolClient.eventSearchConfig.fromBlock,
    toBlock: l1SpokePoolClient.latestBlockSearched,
    maxBlockLookBack: l1SpokePoolClient.eventSearchConfig.maxBlockLookBack,
  };
  const outstandingDeposits = await getAttestationsForCCTPDepositEvents(
    senderAddresses,
    hubPoolClient.chainId,
    l2SpokePoolClient.chainId,
    l2SpokePoolClient.chainId,
    searchConfig
  );
  const unprocessedMessages = outstandingDeposits.filter((message) => message.status === "ready");
  const statusesGrouped = groupObjectCountsByProp(
    outstandingDeposits,
    (message: { status: CCTPMessageStatus }) => message.status
  );
  logger.debug({
    at: `Finalizer#CCTPL1ToL2Finalizer:${l2SpokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} ready to finalize messages for CCTP L1 to ${l2SpokePoolClient.chainId}`,
    statusesGrouped,
  });

  const { address, abi } = getCctpMessageTransmitter(l2SpokePoolClient.chainId, l2SpokePoolClient.chainId);
  const l2MessengerContract = new ethers.Contract(address, abi, l2SpokePoolClient.spokePool.provider);

  return {
    crossChainMessages: await generateDepositData(
      unprocessedMessages,
      hubPoolClient.chainId,
      l2SpokePoolClient.chainId
    ),
    callData: await generateMultiCallData(l2MessengerContract, unprocessedMessages),
  };
}

/**
 * Generates a series of populated transactions that can be consumed by the Multicall2 contract.
 * @param messageTransmitter The CCTPMessageTransmitter contract that will be used to populate the transactions.
 * @param messages The messages to generate transactions for.
 * @returns A list of populated transactions that can be consumed by the Multicall2 contract.
 */
async function generateMultiCallData(
  messageTransmitter: Contract,
  messages: Pick<AttestedCCTPDepositEvent, "attestation" | "messageBytes">[]
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
  messages: Pick<AttestedCCTPDepositEvent, "amount">[],
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
