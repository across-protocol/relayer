import { utils } from "@across-protocol/sdk";
import { PUBLIC_NETWORKS, CCTP_NO_DOMAIN, CHAIN_IDs } from "@across-protocol/constants";
import { TransactionReceipt } from "@ethersproject/abstract-provider";
import axios from "axios";
import { ethers } from "ethers";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumber } from "./BNUtils";
import { bnZero, compareAddressesSimple } from "./SDKUtils";
import { isDefined } from "./TypeGuards";
import { getProvider } from "./ProviderUtils";

export type DecodedCCTPMessage = {
  messageHash: string;
  messageBytes: string;
  nonceHash: string;
  amount: string;
  sourceDomain: number;
  destinationDomain: number;
  attestation: string;
  sender: string;
  status: CCTPMessageStatus;
};

export type Attestation = { status: string; attestation: string };
export type CCTPMessageStatus = "finalized" | "ready" | "pending";

const CCTP_V2_L2_CHAINS = [CHAIN_IDs.LINEA];
export function isCctpV2L2ChainId(chainId: number): boolean {
  return CCTP_V2_L2_CHAINS.includes(chainId);
}

export function getCctpTokenMessenger(
  l2ChainId: number,
  tokenMessengerChainId: number
): { address?: string; abi?: unknown[] } {
  return CONTRACT_ADDRESSES[tokenMessengerChainId][
    isCctpV2L2ChainId(l2ChainId) ? "cctpV2TokenMessenger" : "cctpTokenMessenger"
  ];
}

export function getCctpMessageTransmitter(
  l2ChainId: number,
  messageTransmitterChainId: number
): { address?: string; abi?: unknown[] } {
  return CONTRACT_ADDRESSES[messageTransmitterChainId][
    isCctpV2L2ChainId(l2ChainId) ? "cctpV2MessageTransmitter" : "cctpMessageTransmitter"
  ];
}

/**
 * Used to convert an ETH Address string to a 32-byte hex string.
 * @param address The address to convert.
 * @returns The 32-byte hex string representation of the address - required for CCTP messages.
 */
export function cctpAddressToBytes32(address: string): string {
  return ethers.utils.hexZeroPad(address, 32);
}

/**
 * Used to convert a 32-byte hex string with padding to a standard ETH address.
 * @param bytes32 The 32-byte hex string to convert.
 * @returns The ETH address representation of the 32-byte hex string.
 */
export function cctpBytes32ToAddress(bytes32: string): string {
  // Grab the last 20 bytes of the 32-byte hex string
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(bytes32, 12));
}

/**
 * The CCTP Message Transmitter contract updates a local dictionary for each source domain / nonce it receives. It won't
 * attempt to process a message if the nonce has been seen before. If the nonce has been used before, the message has
 * been received and processed already. This function replicates the `function _hashSourceAndNonce(uint32 _source, uint64 _nonce)` function
 * in the MessageTransmitter contract.
 * @link https://github.com/circlefin/evm-cctp-contracts/blob/817397db0a12963accc08ff86065491577bbc0e5/src/MessageTransmitter.sol#L279-L308
 * @link https://github.com/circlefin/evm-cctp-contracts/blob/817397db0a12963accc08ff86065491577bbc0e5/src/MessageTransmitter.sol#L369-L381
 * @param source The source domain
 * @param nonce The nonce provided by the destination transaction (DepositForBurn event)
 * @returns The hash of the source and nonce following the hashing algorithm of the MessageTransmitter contract.
 */
export function hashCCTPSourceAndNonce(source: number, nonce: number): string {
  // Encode and hash the values directly
  return ethers.utils.keccak256(ethers.utils.solidityPack(["uint32", "uint64"], [source, nonce]));
}

export function getCctpDomainForChainId(chainId: number): number {
  const cctpDomain = PUBLIC_NETWORKS[chainId]?.cctpDomain;
  if (!isDefined(cctpDomain)) {
    throw new Error(`No CCTP domain found for chainId: ${chainId}`);
  }
  return cctpDomain;
}

/**
 * Calls into the CCTP MessageTransmitter contract and determines whether or not a message has been processed.
 * @param nonce The unique nonce hash of the message, derived differently for V1 vs V2.
 * @param contract The CCTP MessageTransmitter contract to call.
 * @returns Whether or not the message has been processed.
 */
async function _hasCCTPMessageBeenProcessed(nonceHash: string, contract: ethers.Contract): Promise<boolean> {
  const resultingCall: BigNumber = await contract.callStatic.usedNonces(nonceHash);
  // If the resulting call is 1, the message has been processed. If it is 0, the message has not been processed.
  return (resultingCall ?? bnZero).toNumber() === 1;
}

/**
 * Used to map a CCTP domain to a chain id. This is the inverse of getCctpDomainForChainId.
 * Note: due to the nature of testnet/mainnet chain ids mapping to the same CCTP domain, we
 *       actually have a mapping of CCTP Domain -> [chainId].
 */
export function getCctpDomainsToChainIds(): Record<number, number[]> {
  return Object.entries(PUBLIC_NETWORKS).reduce((acc, [chainId, networkInfo]) => {
    const cctpDomain = networkInfo.cctpDomain;
    if (cctpDomain === CCTP_NO_DOMAIN) {
      return acc;
    }
    if (!acc[cctpDomain]) {
      acc[cctpDomain] = [];
    }
    acc[cctpDomain].push(Number(chainId));
    return acc;
  }, {});
}

/**
 * Resolves a list of TransactionReceipt objects into a list of DecodedCCTPMessage objects. Each transaction receipt
 * can technically have up to N CCTP messages associated with it. This function will resolve all of the CCTP messages
 * and return them as a single list.
 * @param receipts The list of TransactionReceipt objects to resolve.
 * @param currentChainId The current chain that the receipts were generated on. Messages will be filtered to only those that were sent from this chain.
 * @param targetDestinationChainId The chain that the messages were sent to. Messages will be filtered to only those that were sent to this chain.
 * @returns A list of DecodedCCTPMessage objects. Note: this list may be empty if no CCTP messages were found. Note: this list may contain more elements than the number of receipts passed in.
 */
export async function resolveCCTPRelatedTxns(
  receipts: TransactionReceipt[],
  currentChainId: number,
  targetDestinationChainId: number
): Promise<DecodedCCTPMessage[]> {
  const decodedMessages = await Promise.all(
    receipts.map((receipt) => _resolveCCTPRelatedTxns(receipt, currentChainId, targetDestinationChainId))
  );
  // Flatten the list of lists into a single list
  return decodedMessages.flat();
}

export async function resolveCCTPV2RelatedTxns(
  receipts: TransactionReceipt[],
  currentChainId: number,
  targetDestinationChainId: number
): Promise<DecodedCCTPMessage[]> {
  const decodedMessages = await Promise.all(
    receipts.map((receipt) => _resolveCCTPV2RelatedTxns(receipt, currentChainId, targetDestinationChainId))
  );
  // Flatten the list of lists into a single list
  return decodedMessages.flat();
}

/**
 * Converts a TransactionReceipt object into a DecodedCCTPMessage object, if possible.
 * @param receipt The TransactionReceipt object to convert.
 * @param sourceChainId The chainId that the receipt was generated on.
 * @param destinationChainId The chainId that the message was sent to.
 * @returns A DecodedCCTPMessage object if the receipt is a CCTP message, otherwise undefined.
 */
async function _resolveCCTPRelatedTxns(
  receipt: TransactionReceipt,
  sourceChainId: number,
  destinationChainId: number
): Promise<DecodedCCTPMessage[]> {
  // We need the Event[0] topic to be the MessageSent event.
  // Note: we could use an interface here but we only need the topic
  //       and not the entire contract.
  const cctpEventTopic = ethers.utils.id("MessageSent(bytes)");

  // There's a chance that we will receive a receipt with multiple logs that
  // we need to process. We should filter logs to only those that contain
  // a MessageSent event.
  const relatedLogs = receipt.logs.filter(
    (l) =>
      l.topics[0] === cctpEventTopic &&
      compareAddressesSimple(l.address, CONTRACT_ADDRESSES[sourceChainId].cctpMessageTransmitter.address)
  );

  const cctpDomainsToChainIds = getCctpDomainsToChainIds();

  // We can resolve all of the logs in parallel and produce a flat list of DecodedCCTPMessage objects
  return (
    (
      await Promise.all(
        relatedLogs.map(async (log): Promise<DecodedCCTPMessage> => {
          // We need to decompose the MessageSent event into its constituent parts. At the time of writing, CCTP
          // does not have a canonical SDK so we need to manually decode the event. The event is defined
          // here: https://developers.circle.com/stablecoins/docs/message-format

          const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], log.data)[0];
          const messageBytesArray = ethers.utils.arrayify(messageBytes);
          const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // sourceDomain 4 bytes starting index 4
          const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // destinationDomain 4 bytes starting index 8
          const nonce = BigNumber.from(ethers.utils.hexlify(messageBytesArray.slice(12, 20))).toNumber(); // nonce 8 bytes starting index 12
          const sender = ethers.utils.hexlify(messageBytesArray.slice(32, 52)); // sender 32 bytes starting index 20, but we only need the last 20 bytes so we can start our index at 32
          const nonceHash = hashCCTPSourceAndNonce(sourceDomain, nonce);
          const messageHash = ethers.utils.keccak256(messageBytes);
          const amountSent = ethers.utils.hexlify(messageBytesArray.slice(184, 216)); // amount 32 bytes starting index 216 (idx 68 of body after idx 116 which ends the header)

          // Perform some extra steps to get the source and destination chain ids
          const resolvedPossibleSourceChainIds = cctpDomainsToChainIds[sourceDomain];
          const resolvedPossibleDestinationChainIds = cctpDomainsToChainIds[destinationDomain];

          // Ensure that we're only processing CCTP messages that are both from the source chain and destined for the target destination chain
          if (
            !resolvedPossibleSourceChainIds?.includes(sourceChainId) ||
            !resolvedPossibleDestinationChainIds?.includes(destinationChainId)
          ) {
            return undefined;
          }

          // Check to see if the message has already been processed
          const destinationProvider = await getProvider(destinationChainId);
          const destinationMessageTransmitterContract = CONTRACT_ADDRESSES[destinationChainId].cctpMessageTransmitter;
          const destinationMessageTransmitter = new ethers.Contract(
            destinationMessageTransmitterContract.address,
            destinationMessageTransmitterContract.abi,
            destinationProvider
          );
          const processed = await _hasCCTPMessageBeenProcessed(nonceHash, destinationMessageTransmitter);

          let status: CCTPMessageStatus;
          let attestation: Attestation | undefined = undefined;
          if (processed) {
            status = "finalized";
          } else {
            // Generate the attestation proof for the message. This is required to finalize the message.
            attestation = await _generateCCTPAttestationProof(messageHash, utils.chainIsProd(destinationChainId));
            // If the attestation proof is pending, we can't finalize the message yet.
            status = attestation.status === "pending_confirmations" ? "pending" : "ready";
          }

          return {
            sender,
            messageHash,
            messageBytes,
            nonceHash,
            amount: BigNumber.from(amountSent).toString(),
            sourceDomain: sourceDomain,
            destinationDomain: destinationDomain,
            attestation: attestation?.attestation,
            status,
          };
        })
      )
    )
      // Ensure that we only return defined values
      .filter(isDefined)
  );
}

async function _resolveCCTPV2RelatedTxns(
  receipt: TransactionReceipt,
  sourceChainId: number,
  destinationChainId: number
): Promise<DecodedCCTPMessage[]> {
  // We need the Event[0] topic to be the MessageSent event.
  // Note: we could use an interface here but we only need the topic
  //       and not the entire contract.
  const cctpEventTopic = ethers.utils.id("MessageSent(bytes)");

  // There's a chance that we will receive a receipt with multiple logs that
  // we need to process. We should filter logs to only those that contain
  // a MessageSent event.
  const relatedLogs = receipt.logs.filter(
    (l) =>
      l.topics[0] === cctpEventTopic &&
      compareAddressesSimple(l.address, CONTRACT_ADDRESSES[sourceChainId].cctpV2MessageTransmitter.address)
  );

  const cctpDomainsToChainIds = getCctpDomainsToChainIds();

  // We can resolve all of the logs in parallel and produce a flat list of DecodedCCTPMessage objects
  return (
    (
      await Promise.all(
        relatedLogs.map(async (log): Promise<DecodedCCTPMessage> => {
          // We need to decompose the MessageSent event into its constituent parts. At the time of writing, CCTP
          // does not have a canonical SDK so we need to manually decode the event. The event is defined
          // here: https://developers.circle.com/stablecoins/docs/message-format

          const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], log.data)[0];
          const messageBytesArray = ethers.utils.arrayify(messageBytes);
          const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // sourceDomain 4 bytes starting index 4
          const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // destinationDomain 4 bytes starting index 8
          const nonceHash = ethers.utils.hexlify(messageBytesArray.slice(12, 44)); // nonce 32 bytes starting index 12
          const sender = ethers.utils.hexlify(messageBytesArray.slice(56, 76)); // sender 32 bytes starting index 44, but we only need the last 20 bytes so we can start our index at 56
          const messageHash = ethers.utils.keccak256(messageBytes);
          const amountSent = ethers.utils.hexlify(messageBytesArray.slice(216, 248)); // amount 32 bytes starting index 216 (idx 68 of body after idx 148 which ends the header)

          // Perform some extra steps to get the source and destination chain ids
          const resolvedPossibleSourceChainIds = cctpDomainsToChainIds[sourceDomain];
          const resolvedPossibleDestinationChainIds = cctpDomainsToChainIds[destinationDomain];

          // Ensure that we're only processing CCTP messages that are both from the source chain and destined for the target destination chain
          if (
            !resolvedPossibleSourceChainIds?.includes(sourceChainId) ||
            !resolvedPossibleDestinationChainIds?.includes(destinationChainId)
          ) {
            return undefined;
          }

          // Check to see if the message has already been processed
          const destinationProvider = await getProvider(destinationChainId);
          const destinationMessageTransmitterContract = CONTRACT_ADDRESSES[destinationChainId].cctpV2MessageTransmitter;
          const destinationMessageTransmitter = new ethers.Contract(
            destinationMessageTransmitterContract.address,
            destinationMessageTransmitterContract.abi,
            destinationProvider
          );
          const processed = await _hasCCTPMessageBeenProcessed(nonceHash, destinationMessageTransmitter);

          let status: CCTPMessageStatus;
          let attestation: Attestation | undefined = undefined;
          if (processed) {
            status = "finalized";
          } else {
            // Generate the attestation proof for the message. This is required to finalize the message.
            attestation = await _generateCCTPV2AttestationProof(
              sourceDomain,
              receipt.transactionHash,
              nonceHash,
              utils.chainIsProd(destinationChainId)
            );
            // If the attestation proof is pending, we can't finalize the message yet.
            status = attestation.status === "pending_confirmations" ? "pending" : "ready";
          }

          return {
            sender,
            messageHash,
            messageBytes,
            nonceHash,
            amount: BigNumber.from(amountSent).toString(),
            sourceDomain: sourceDomain,
            destinationDomain: destinationDomain,
            attestation: attestation?.attestation,
            status,
          };
        })
      )
    )
      // Ensure that we only return defined values
      .filter(isDefined)
  );
}

/**
 * Generates an attestation proof for a given message hash. This is required to finalize a CCTP message.
 * @param messageHash The message hash to generate an attestation proof for. This is generated by taking the keccak256 hash of the message bytes of the initial transaction log.
 * @param isMainnet Whether or not the attestation proof should be generated on mainnet. If this is false, the attestation proof will be generated on the sandbox environment.
 * @returns The attestation status and proof for the given message hash. This is a string of the form "0x<attestation proof>". If the status is pending_confirmation
 * then the proof will be null according to the CCTP dev docs.
 * @link https://developers.circle.com/stablecoins/reference/getattestation
 */
async function _generateCCTPAttestationProof(messageHash: string, isMainnet: boolean): Promise<Attestation> {
  const httpResponse = await axios.get<Attestation>(
    `https://iris-api${isMainnet ? "" : "-sandbox"}.circle.com/attestations/${messageHash}`
  );
  const attestationResponse = httpResponse.data;
  return attestationResponse;
}

async function _generateCCTPV2AttestationProof(
  sourceDomainId: number,
  transactionHash: string,
  nonceHash: string,
  isMainnet: boolean
): Promise<Attestation> {
  const httpResponse = await axios.get<Attestation>(
    `https://iris-api${
      isMainnet ? "" : "-sandbox"
    }.circle.com/v2/messages/${sourceDomainId}?transactionHash=${transactionHash}&nonceHash=${nonceHash}`
  );
  const attestationResponse = httpResponse.data;
  return attestationResponse;
}
