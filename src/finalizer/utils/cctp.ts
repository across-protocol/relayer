/* eslint-disable @typescript-eslint/no-unused-vars */
import axios, { AxiosError } from "axios";
import { ethers } from "hardhat";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call, chainIdsToCctpDomains } from "../../common";
import { BigNumber, Contract, Signer, TransactionReceipt, isDefined, winston } from "../../utils";
import { FinalizerPromise, Withdrawal } from "../types";
import { TransactionRequest } from "@ethersproject/abstract-provider";

type DecodedCCTPMessage = {
  messageHash: string;
  messageBytes: string;
  nonceHash: string;
  amount: string;
  sourceDomain: number;
  destinationDomain: number;
  attestation: string;
};

// FIXME: REMOVE THIS - ONLY FOR TESTING
const testBaseProvider = new ethers.providers.JsonRpcProvider("https://sepolia.base.org");
const testSepoliaProvider = new ethers.providers.JsonRpcProvider("https://rpc.sepolia.org");

export async function cctpFinalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const l1Signer = hubPoolClient.hubPool.signer;
  const l2Signer = spokePoolClient.spokePool.signer;
  const [l1ToL2, l2ToL1] = await Promise.all([
    l1ToL2Finalizer(l2Signer, hubPoolClient, spokePoolClient, latestBlockToFinalize),
    l2ToL1Finalizer(l1Signer, hubPoolClient, spokePoolClient, latestBlockToFinalize),
  ]);
  console.log({
    withdrawals: [...l1ToL2.withdrawals, ...l2ToL1.withdrawals],
    callData: [...l1ToL2.callData, ...l2ToL1.callData],
  });
  return {
    withdrawals: [],
    callData: [],
  };
  // return {
  //   withdrawals: [...l1ToL2.withdrawals, ...l2ToL1.withdrawals],
  //   callData: [...l1ToL2.callData, ...l2ToL1.callData],
  // };
}

async function l1ToL2Finalizer(
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const decodedMessages = await resolveCCTPRelatedTxnsOnL1(
    hubPoolClient,
    spokePoolClient.chainId,
    latestBlockToFinalize
  );
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[hubPoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(cctpMessageReceiverDetails.address, cctpMessageReceiverDetails.abi, signer);
  return {
    withdrawals: await generateWithdrawalData(decodedMessages, hubPoolClient.chainId, spokePoolClient.chainId),
    callData: await generateMultiCallData(contract, decodedMessages),
  };
}

async function l2ToL1Finalizer(
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const decodedMessages = await resolveCCTPRelatedTxnsOnL2(
    spokePoolClient,
    hubPoolClient.chainId,
    latestBlockToFinalize
  );
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[hubPoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(cctpMessageReceiverDetails.address, cctpMessageReceiverDetails.abi, signer);
  return {
    withdrawals: await generateWithdrawalData(decodedMessages, spokePoolClient.chainId, hubPoolClient.chainId),
    callData: await generateMultiCallData(contract, decodedMessages),
  };
}

async function resolveCCTPRelatedTxnsOnL2(
  client: SpokePoolClient,
  targetDestinationChainId: number,
  latestBlockToFinalize: number
): Promise<DecodedCCTPMessage[]> {
  // Resolve the receipts to all collected txns
  const txnReceipts = await Promise.all(
    client
      .getTokensBridged()
      .filter((bridgeEvent) => bridgeEvent.blockNumber > latestBlockToFinalize)
      .map((bridgeEvent) => client.spokePool.provider.getTransactionReceipt(bridgeEvent.transactionHash))
  );

  // FIXME: REMOVE THIS - ONLY FOR TESTING
  txnReceipts.push(
    await testBaseProvider.getTransactionReceipt("0x98e0e37e0e6272661f773460a1cab48ea744fd3f800ca2d335226b5473182d27")
  );

  return resolveCCTPRelatedTxns(txnReceipts, client.chainId, targetDestinationChainId);
}

async function resolveCCTPRelatedTxnsOnL1(
  client: HubPoolClient,
  targetDestinationChainId: number,
  latestBlockToFinalize: number
): Promise<DecodedCCTPMessage[]> {
  // Resolve the receipts to all collected txns
  const txnReceipts = await Promise.all(
    client
      .getExecutedRootBundles()
      .filter((bundle) => bundle.blockNumber > latestBlockToFinalize)
      .map((bundle) => client.hubPool.provider.getTransactionReceipt(bundle.transactionHash))
  );

  // FIXME: REMOVE THIS - ONLY FOR TESTING
  txnReceipts.push(
    await testSepoliaProvider.getTransactionReceipt(
      "0x98e0e37e0e6272661f773460a1cab48ea744fd3f800ca2d335226b5473182d27"
    )
  );

  return resolveCCTPRelatedTxns(txnReceipts, client.chainId, targetDestinationChainId);
}

async function resolveCCTPRelatedTxns(
  receipts: TransactionReceipt[],
  currentChainId: number,
  targetDestinationChainId: number
): Promise<DecodedCCTPMessage[]> {
  return (
    await Promise.all(
      receipts.map((receipt) => _resolveCCTPRelatedTxn(receipt, currentChainId, targetDestinationChainId))
    )
  ).filter(isDefined);
}

/**
 * Converts a TransactionReceipt object into a DecodedCCTPMessage object, if possible.
 * @param receipt The TransactionReceipt object to convert.
 * @param currentChainId The chainId that the receipt was generated on.
 * @param targetDestinationChainId The chainId that the message was sent to.
 * @returns A DecodedCCTPMessage object if the receipt is a CCTP message, otherwise undefined.
 */
async function _resolveCCTPRelatedTxn(
  receipt: TransactionReceipt,
  currentChainId: number,
  targetDestinationChainId: number
): Promise<DecodedCCTPMessage> {
  // We need the Event[0] topic to be the MessageSent event.
  // Note: we could use an interface here but we only need the topic
  //       and not the entire contract.
  const cctpEventTopic = ethers.utils.id("MessageSent(bytes)");
  const log = receipt.logs.find(
    (l) =>
      l.topics[0] === cctpEventTopic && l.address === CONTRACT_ADDRESSES[currentChainId].cctpMessageTransmitter.address
  );
  // If we can't find a log that contains a MessageSent event, we should return undefined
  if (!log) {
    return undefined;
  }
  // We need to decode the message bytes from the log data
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], log.data)[0];
  // We need to further decode the message bytes to get the sourceDomain, destinationDomain, nonce, and amount
  const messageBytesArray = ethers.utils.arrayify(messageBytes);
  const sourceDomain = ethers.utils.hexlify(messageBytesArray.slice(4, 8)); // sourceDomain 4 bytes starting index 4
  const destinationDomain = ethers.utils.hexlify(messageBytesArray.slice(8, 12)); // destinationDomain 4 bytes starting index 8
  const nonce = ethers.utils.hexlify(messageBytesArray.slice(12, 20)); // nonce 8 bytes starting index 12
  const nonceHash = ethers.utils.solidityKeccak256(["uint32", "uint64"], [sourceDomain, nonce]);
  const messageHash = ethers.utils.keccak256(messageBytes);
  const amountSent = ethers.utils.hexlify(messageBytesArray.slice(184, 216)); // amount 32 bytes starting index 216 (idx 68 of body after idx 116 which ends the header)

  // Ensure that we're only processing CCTP messages that are destined for the target destination chain
  if (Number(destinationDomain) !== chainIdsToCctpDomains[targetDestinationChainId]) {
    return undefined;
  }

  // Generate the attestation proof for the message. This is required to finalize the message.
  const attestation = await generateCCTPAttestationProof(messageHash);

  // If we can't generate an attestation proof, we should return undefined
  if (!attestation) {
    return undefined;
  }

  return {
    messageHash,
    messageBytes,
    nonceHash,
    amount: BigNumber.from(amountSent).toString(),
    sourceDomain: Number(sourceDomain),
    destinationDomain: Number(destinationDomain),
    attestation,
  };
}

/**
 * Generates an attestation proof for a given message hash. This is required to finalize a CCTP message.
 * @param messageHash The message hash to generate an attestation proof for. This is generated by taking the keccak256 hash of the message bytes of the initial transaction log.
 * @returns The attestation proof for the given message hash. This is a string of the form "0x<attestation proof>".
 * @throws An error if the attestation proof cannot be generated. We wait a maximum of 10 seconds for the attestation to be generated. If it is not generated in that time, we throw an error.
 */
async function generateCCTPAttestationProof(messageHash: string) {
  let maxTries = 5;
  let attestationResponse: { status: string; attestation: string } = { status: "pending", attestation: "" };
  while (attestationResponse.status !== "complete" && maxTries-- > 0) {
    try {
      const httpResponse = await axios.get<{ status: string; attestation: string }>(
        `https://iris-api-sandbox.circle.com/attestations/${messageHash}`
      );
      attestationResponse = httpResponse.data;
      if (attestationResponse.status === "complete") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } catch (e) {
      if (e instanceof AxiosError && e.response?.status === 404) {
        // Not enough time has passed for the attestation to be generated
        // We should return and try again later
        return undefined;
      } else {
        // An unknown error occurred. We should throw it up the stack
        throw e;
      }
    }
  }
  // Attetestation was not able to be generated. We should throw an error
  if (attestationResponse.status !== "complete") {
    throw new Error("Failed to generate attestation proof");
  }
  return attestationResponse.attestation;
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
 * @param sourceChainId The chain that these messages originated from
 * @param executionChainId The chain that these messages will be executed on
 * @returns A list of valid withdrawals for a given list of CCTP messages.
 */
async function generateWithdrawalData(
  messages: DecodedCCTPMessage[],
  sourceChainId: number,
  executionChainId: number
): Promise<Withdrawal[]> {
  return messages.map((message) => ({
    l1TokenSymbol: "USDC", // Always USDC b/c that's the only token we support on CCTP
    amount: message.amount,
    type: "withdrawal",
    l2ChainId: sourceChainId,
    // FIXME: We're overriding this to be sepolia
    executionChainId: 11155111 ?? executionChainId,
  }));
}
