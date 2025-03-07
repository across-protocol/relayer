import { utils } from "@across-protocol/sdk";
import { PUBLIC_NETWORKS, CCTP_NO_DOMAIN } from "@across-protocol/constants";
import { TransactionReceipt } from "@ethersproject/abstract-provider";
import axios from "axios";
import { ethers } from "ethers";
import { Log } from "../interfaces";
import { CONTRACT_ADDRESSES } from "../common";
import { EventSearchConfig, paginatedEventQuery } from "./EventUtils";
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
  nonce: number;
  status: CCTPMessageStatus;
};

export type Attestation = { status: string; attestation: string };
export type CCTPMessageStatus = "finalized" | "ready" | "pending";

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
 * Retrieves all outstanding CCTP bridge transfers for a given target -> destination chain, a source token address, and a from address.
 * @param sourceTokenMessenger The CCTP TokenMessenger contract on the source chain. The "Bridge Contract" of CCTP
 * @param destinationMessageTransmitter The CCTP MessageTransmitter contract on the destination chain. The "Message Handler Contract" of CCTP
 * @param sourceSearchConfig The search configuration to use when querying the sourceTokenMessenger contract via `paginatedEventQuery`.
 * @param sourceToken The token address of the token being transferred.
 * @param sourceChainId The chainId of the source chain.
 * @param destinationChainId The chainId of the destination chain.
 * @param fromAddress The address that initiated the transfer.
 * @returns A list of outstanding CCTP bridge transfers. These are transfers that have been initiated but not yet finalized on the destination chain.
 * @dev Reference `hasCCTPMessageBeenProcessed` for more information on how the message is determined to be processed.
 */
export async function retrieveOutstandingCCTPBridgeUSDCTransfers(
  sourceTokenMessenger: ethers.Contract,
  destinationMessageTransmitter: ethers.Contract,
  sourceSearchConfig: EventSearchConfig,
  sourceToken: string,
  sourceChainId: number,
  destinationChainId: number,
  fromAddress: string
): Promise<Log[]> {
  const sourceDomain = getCctpDomainForChainId(sourceChainId);
  const targetDestinationDomain = getCctpDomainForChainId(destinationChainId);

  const sourceFilter = sourceTokenMessenger.filters.DepositForBurn(undefined, sourceToken, undefined, fromAddress);
  const initializationTransactions = await paginatedEventQuery(sourceTokenMessenger, sourceFilter, sourceSearchConfig);

  const outstandingTransactions = await Promise.all(
    initializationTransactions.map(async (event) => {
      const { nonce, destinationDomain } = event.args;
      // Ensure that the destination domain matches the target destination domain so that we don't
      // have any double counting of messages.
      if (destinationDomain !== targetDestinationDomain) {
        return undefined;
      }
      // Call into the destinationMessageTransmitter contract to determine if the message has been processed
      // on the destination chain. We want to make sure the message **hasn't** been processed.
      const isMessageProcessed = await hasCCTPMessageBeenProcessed(sourceDomain, nonce, destinationMessageTransmitter);
      if (isMessageProcessed) {
        return undefined;
      }
      return event;
    })
  );

  return outstandingTransactions.filter(isDefined);
}

/**
 * Calls into the CCTP MessageTransmitter contract and determines whether or not a message has been processed.
 * @param sourceDomain The source domain of the message.
 * @param nonce The nonce of the message.
 * @param contract The CCTP MessageTransmitter contract to call.
 * @returns Whether or not the message has been processed.
 */
export async function hasCCTPMessageBeenProcessed(
  sourceDomain: number,
  nonce: number,
  contract: ethers.Contract
): Promise<boolean> {
  const nonceHash = hashCCTPSourceAndNonce(sourceDomain, nonce);
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
          const nonceHash = ethers.utils.solidityKeccak256(["uint32", "uint64"], [sourceDomain, nonce]);
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
          const processed = await hasCCTPMessageBeenProcessed(sourceDomain, nonce, destinationMessageTransmitter);

          let status: CCTPMessageStatus;
          let attestation: Attestation | undefined = undefined;
          if (processed) {
            status = "finalized";
          } else {
            // Generate the attestation proof for the message. This is required to finalize the message.
            attestation = await generateCCTPAttestationProof(messageHash, utils.chainIsProd(destinationChainId));
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
            nonce,
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
async function generateCCTPAttestationProof(messageHash: string, isMainnet: boolean): Promise<Attestation> {
  const httpResponse = await axios.get<Attestation>(
    `https://iris-api${isMainnet ? "" : "-sandbox"}.circle.com/attestations/${messageHash}`
  );
  const attestationResponse = httpResponse.data;
  return attestationResponse;
}
