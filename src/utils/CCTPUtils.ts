import { TransactionReceipt } from "@ethersproject/abstract-provider";
import axios, { AxiosError } from "axios";
import { ethers, BigNumber } from "ethers";
import { CONTRACT_ADDRESSES, chainIdsToCctpDomains } from "../common";
import { isDefined } from "./TypeGuards";

export type DecodedCCTPMessage = {
  messageHash: string;
  messageBytes: string;
  nonceHash: string;
  amount: string;
  sourceDomain: number;
  destinationDomain: number;
  attestation: string;
};

/**
 * Used to map a CCTP domain to a chain id. This is the inverse of chainIdsToCctpDomains.
 * Note: due to the nature of testnet/mainnet chain ids mapping to the same CCTP domain, we
 *       actually have a mapping of CCTP Domain -> [chainId].
 */
const cctpDomainsToChainIds = Object.entries(chainIdsToCctpDomains).reduce((acc, [chainId, cctpDomain]) => {
  if (!acc[cctpDomain]) {
    acc[cctpDomain] = [];
  }
  acc[cctpDomain].push(Number(chainId));
  return acc;
}, {} as Record<number, number[]>);

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
      l.topics[0] === cctpEventTopic && l.address === CONTRACT_ADDRESSES[sourceChainId].cctpMessageTransmitter.address
  );

  // We can resolve all of the logs in parallel and produce a flat list of DecodedCCTPMessage objects
  return (
    (
      await Promise.all(
        relatedLogs.map(async (log) => {
          // We need to decompose the MessageSent event into its constituent parts. At the time of writing, CCTP
          // does not have a canonical SDK so we need to manually decode the event. The event is defined
          // here: https://developers.circle.com/stablecoins/docs/message-format

          const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], log.data)[0];
          const messageBytesArray = ethers.utils.arrayify(messageBytes);
          const sourceDomain = ethers.utils.hexlify(messageBytesArray.slice(4, 8)); // sourceDomain 4 bytes starting index 4
          const destinationDomain = ethers.utils.hexlify(messageBytesArray.slice(8, 12)); // destinationDomain 4 bytes starting index 8
          const nonce = ethers.utils.hexlify(messageBytesArray.slice(12, 20)); // nonce 8 bytes starting index 12
          const nonceHash = ethers.utils.solidityKeccak256(["uint32", "uint64"], [sourceDomain, nonce]);
          const messageHash = ethers.utils.keccak256(messageBytes);
          const amountSent = ethers.utils.hexlify(messageBytesArray.slice(184, 216)); // amount 32 bytes starting index 216 (idx 68 of body after idx 116 which ends the header)

          // Perform some extra steps to get the source and destination chain ids
          const resolvedPossibleSourceChainIds = cctpDomainsToChainIds[Number(sourceDomain)];
          const resolvedPossibleDestinationChainIds = cctpDomainsToChainIds[Number(destinationDomain)];

          // Ensure that we're only processing CCTP messages that are both from the source chain and destined for the target destination chain
          if (
            !resolvedPossibleSourceChainIds?.includes(sourceChainId) ||
            !resolvedPossibleDestinationChainIds?.includes(destinationChainId)
          ) {
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
  // Return the attestation proof since it was generated
  return attestationResponse.attestation;
}
