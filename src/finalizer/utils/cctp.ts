/* eslint-disable @typescript-eslint/no-unused-vars */
import axios from "axios";
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
    l1ToL2Finalizer(logger, l2Signer, hubPoolClient, spokePoolClient, latestBlockToFinalize),
    l2ToL1Finalizer(logger, l1Signer, hubPoolClient, spokePoolClient, latestBlockToFinalize),
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
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const decodedMessages = await resolveCCTPRelatedTxnsOnL1(hubPoolClient, spokePoolClient.chainId);
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[hubPoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(cctpMessageReceiverDetails.address, cctpMessageReceiverDetails.abi, signer);
  return {
    withdrawals: await generateWithdrawalData(decodedMessages, hubPoolClient.chainId, spokePoolClient.chainId),
    callData: await generateMultiCallData(contract, decodedMessages),
  };
}

async function l2ToL1Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const decodedMessages = await resolveCCTPRelatedTxnsOnL2(spokePoolClient, hubPoolClient.chainId);
  const cctpMessageReceiverDetails = CONTRACT_ADDRESSES[hubPoolClient.chainId].cctpMessageTransmitter;
  const contract = new ethers.Contract(cctpMessageReceiverDetails.address, cctpMessageReceiverDetails.abi, signer);
  return {
    withdrawals: await generateWithdrawalData(decodedMessages, spokePoolClient.chainId, hubPoolClient.chainId),
    callData: await generateMultiCallData(contract, decodedMessages),
  };
}

async function resolveCCTPRelatedTxnsOnL2(
  client: SpokePoolClient,
  targetDestinationChainId: number
): Promise<DecodedCCTPMessage[]> {
  // Resolve the receipts to all collected txns
  const txnReceipts = [
    ...(await Promise.all(
      client
        .getTokensBridged()
        .map((bridgeEvent) => client.spokePool.provider.getTransactionReceipt(bridgeEvent.transactionHash))
    )),
    // FIXME: REMOVE THIS - ONLY FOR TESTING
    // await testBaseProvider.getTransactionReceipt("0x98e0e37e0e6272661f773460a1cab48ea744fd3f800ca2d335226b5473182d27"),
  ];
  return (
    await Promise.all(
      txnReceipts.map((receipt) => _resolveCCTPRelatedTxn(receipt, client.chainId, targetDestinationChainId))
    )
  ).filter(isDefined);
}

async function resolveCCTPRelatedTxnsOnL1(
  client: HubPoolClient,
  targetDestinationChainId: number
): Promise<DecodedCCTPMessage[]> {
  // Grab the last bundle
  const bundles = client.getNthFullyExecutedRootBundle(1);
  return [];
}

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
  if (!log) {
    return undefined;
  }
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], log.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);
  const sourceDomain = ethers.utils.hexlify(messageBytesArray.slice(4, 8)); // sourceDomain 4 bytes starting index 4
  const destinationDomain = ethers.utils.hexlify(messageBytesArray.slice(8, 12)); // destinationDomain 4 bytes starting index 8
  const nonce = ethers.utils.hexlify(messageBytesArray.slice(12, 20)); // nonce 8 bytes starting index 12
  const nonceHash = ethers.utils.solidityKeccak256(["uint32", "uint64"], [sourceDomain, nonce]);
  const messageHash = ethers.utils.keccak256(messageBytes);
  const amountSent = ethers.utils.hexlify(messageBytesArray.slice(184, 216)); // amount 32 bytes starting index 216 (idx 68 of body after idx 116 which ends the header)

  if (Number(destinationDomain) !== chainIdsToCctpDomains[targetDestinationChainId]) {
    return undefined;
  }

  const attestation = await generateCCTPAttestationProof(messageHash);

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

async function generateCCTPAttestationProof(messageHash: string) {
  let maxTries = 5;
  let attestationResponse: { status: string; attestation: string } = { status: "pending", attestation: "" };
  while (attestationResponse.status !== "complete" && maxTries-- > 0) {
    const httpResponse = await axios.get<{ status: string; attestation: string }>(
      `https://iris-api-sandbox.circle.com/attestations/${messageHash}`
    );
    attestationResponse = httpResponse.data;
    if (attestationResponse.status === "complete") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return attestationResponse.attestation;
}

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
