import { utils } from "@across-protocol/sdk";
import { PUBLIC_NETWORKS, CHAIN_IDs, TOKEN_SYMBOLS_MAP, CCTP_NO_DOMAIN } from "@across-protocol/constants";
import axios from "axios";
import { Contract, ethers } from "ethers";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumber } from "./BNUtils";
import { bnZero, compareAddressesSimple } from "./SDKUtils";
import { isDefined } from "./TypeGuards";
import { getCachedProvider } from "./ProviderUtils";
import { EventSearchConfig, paginatedEventQuery } from "./EventUtils";
import { findLast } from "lodash";
import { Log } from "../interfaces";

type CCTPDeposit = {
  nonceHash: string;
  amount: string;
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;
  messageHash: string;
  messageBytes: string;
};
type CCTPDepositEvent = CCTPDeposit & { log: Log };
type CCTPAPIGetAttestationResponse = { status: string; attestation: string };
type CCTPV2APIAttestation = {
  status: string;
  attestation: string;
  message: string;
  eventNonce: string;
  cctpVersion: number;
};
type CCTPV2APIGetAttestationResponse = { messages: CCTPV2APIAttestation[] };
function isCctpV2ApiResponse(
  obj: CCTPAPIGetAttestationResponse | CCTPV2APIGetAttestationResponse
): obj is CCTPV2APIGetAttestationResponse {
  return (obj as CCTPV2APIGetAttestationResponse).messages !== undefined;
}
export type CCTPMessageStatus = "finalized" | "ready" | "pending";
export type AttestedCCTPDepositEvent = CCTPDepositEvent & { log: Log; status: CCTPMessageStatus; attestation?: string };

const CCTP_MESSAGE_SENT_TOPIC_HASH = ethers.utils.id("MessageSent(bytes)");

const CCTP_V2_L2_CHAINS = [CHAIN_IDs.LINEA];

/**
 * @notice Returns whether the chainId is a CCTP V2 chain, based on a hardcoded list of CCTP V2 chain ID's
 * @param chainId
 * @returns True if the chainId is a CCTP V2 chain
 */
export function isCctpV2L2ChainId(chainId: number): boolean {
  return CCTP_V2_L2_CHAINS.includes(chainId);
}

/**
 * @notice Returns TokenMessenger contract details on tokenMessengerChainId.
 * @param l2ChainId Used to determine whether to load the V1 or V2 contract.
 * @param tokenMessengerChainId
 * @returns Address and ABI
 */
export function getCctpTokenMessenger(
  l2ChainId: number,
  tokenMessengerChainId: number
): { address?: string; abi?: unknown[] } {
  return CONTRACT_ADDRESSES[tokenMessengerChainId][
    isCctpV2L2ChainId(l2ChainId) ? "cctpV2TokenMessenger" : "cctpTokenMessenger"
  ];
}

/**
 * @notice Returns MessageTransmitter contract details on tokenMessengerChainId.
 * @param l2ChainId Used to determine whether to load the V1 or V2 contract.
 * @param tokenMessengerChainId
 * @returns Address and ABI
 */
export function getCctpMessageTransmitter(
  l2ChainId: number,
  messageTransmitterChainId: number
): { address?: string; abi?: unknown[] } {
  return CONTRACT_ADDRESSES[messageTransmitterChainId][
    isCctpV2L2ChainId(l2ChainId) ? "cctpV2MessageTransmitter" : "cctpMessageTransmitter"
  ];
}

/**
 * @notice Converts an ETH Address string to a 32-byte hex string.
 * @param address The address to convert.
 * @returns The 32-byte hex string representation of the address - required for CCTP messages.
 */
export function cctpAddressToBytes32(address: string): string {
  return ethers.utils.hexZeroPad(address, 32);
}

/**
 * Converts a 32-byte hex string with padding to a standard ETH address.
 * @param bytes32 The 32-byte hex string to convert.
 * @returns The ETH address representation of the 32-byte hex string.
 */
export function cctpBytes32ToAddress(bytes32: string): string {
  // Grab the last 20 bytes of the 32-byte hex string
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(bytes32, 12));
}

/**
 * @notice Returns the CCTP domain for a given chain ID. Throws if the chain ID is not a CCTP domain.
 * @param chainId
 * @returns CCTP Domain ID
 */
export function getCctpDomainForChainId(chainId: number): number {
  const cctpDomain = PUBLIC_NETWORKS[chainId]?.cctpDomain;
  if (!isDefined(cctpDomain) || cctpDomain === CCTP_NO_DOMAIN) {
    throw new Error(`No CCTP domain found for chainId: ${chainId}`);
  }
  return cctpDomain;
}

async function getCCTPDepositEvents(
  senderAddresses: string[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<CCTPDepositEvent[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);

  // Step 1: Get all DepositForBurn events matching the senderAddress and source chain.
  const srcProvider = getCachedProvider(sourceChainId);
  const { address, abi } = getCctpTokenMessenger(l2ChainId, sourceChainId);
  const srcTokenMessenger = new Contract(address, abi, srcProvider);
  const eventFilterParams = isCctpV2
    ? [TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId], undefined, senderAddresses]
    : [undefined, TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId], undefined, senderAddresses];
  const eventFilter = srcTokenMessenger.filters.DepositForBurn(...eventFilterParams);
  const depositForBurnEvents = (
    await paginatedEventQuery(srcTokenMessenger, eventFilter, sourceEventSearchConfig)
  ).filter((e) => e.args.destinationDomain === getCctpDomainForChainId(destinationChainId));

  // Step 2: Get TransactionReceipt for all these events, which we'll use to find the accompanying MessageSent events.
  const receipts = await Promise.all(
    depositForBurnEvents.map((event) => srcProvider.getTransactionReceipt(event.transactionHash))
  );
  const messageSentEvents = depositForBurnEvents.map(({ transactionHash: txnHash, logIndex }, i) => {
    // The MessageSent event should always precede the DepositForBurn event in the same transaction. We should
    // search from right to left so we find the nearest preceding MessageSent event.
    const _messageSentEvent = findLast(
      receipts[i].logs,
      (l) => l.topics[0] === CCTP_MESSAGE_SENT_TOPIC_HASH && l.logIndex < logIndex
    );
    if (!isDefined(_messageSentEvent)) {
      throw new Error(
        `Could not find MessageSent event for DepositForBurn event in ${txnHash} at log index ${logIndex}`
      );
    }
    return _messageSentEvent;
  });

  // Step 3. Decode the MessageSent events to find the message nonce, which we can use to query the deposit status,
  // get the attestation, and further filter the events.
  const decodedMessages = messageSentEvents.map((_messageSentEvent, i) => {
    const {
      sender: decodedSender,
      nonceHash,
      amount: decodedAmount,
      sourceDomain: decodedSourceDomain,
      destinationDomain: decodedDestinationDomain,
      recipient: decodedRecipient,
      messageHash,
      messageBytes,
    } = isCctpV2 ? _decodeCCTPV2Message(_messageSentEvent) : _decodeCCTPV1Message(_messageSentEvent);
    const _depositEvent = depositForBurnEvents[i];

    // Step 4. [Optional] Verify that decoded message matches the DepositForBurn event. We can skip this step
    // if we find this reduces performance.
    if (
      !compareAddressesSimple(decodedSender, _depositEvent.args.depositor) ||
      !compareAddressesSimple(decodedRecipient, cctpBytes32ToAddress(_depositEvent.args.mintRecipient)) ||
      !BigNumber.from(decodedAmount).eq(_depositEvent.args.amount) ||
      decodedSourceDomain !== getCctpDomainForChainId(sourceChainId) ||
      decodedDestinationDomain !== getCctpDomainForChainId(destinationChainId)
    ) {
      const { transactionHash: txnHash, logIndex } = _depositEvent;
      throw new Error(
        `Decoded message at log index ${_messageSentEvent.logIndex}` +
          ` does not match the DepositForBurn event in ${txnHash} at log index ${logIndex}`
      );
    }
    return {
      nonceHash,
      sender: decodedSender,
      recipient: decodedRecipient,
      amount: decodedAmount,
      sourceDomain: decodedSourceDomain,
      destinationDomain: decodedDestinationDomain,
      messageHash,
      messageBytes,
      log: _depositEvent,
    };
  });

  return decodedMessages;
}

async function getCCTPDepositEventsWithStatus(
  senderAddresses: string[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<AttestedCCTPDepositEvent[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const deposits = await getCCTPDepositEvents(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    sourceEventSearchConfig
  );
  const dstProvider = getCachedProvider(destinationChainId);
  const { address, abi } = getCctpMessageTransmitter(l2ChainId, destinationChainId);
  const destinationMessageTransmitter = new ethers.Contract(address, abi, dstProvider);
  return await Promise.all(
    deposits.map(async (deposit) => {
      // @dev Currently we have no way to recreate the V2 nonce hash until after we've received the attestation,
      // so skip this step for V2 since we have no way of knowing whether the message is finalized until after we
      // query the Attestation API service.
      if (isCctpV2) {
        return {
          ...deposit,
          status: "pending",
        };
      }
      const processed = await _hasCCTPMessageBeenProcessed(deposit.nonceHash, destinationMessageTransmitter);
      if (!processed) {
        return {
          ...deposit,
          status: "pending", // We'll flip to ready once we get the attestation
        };
      } else {
        return {
          ...deposit,
          status: "finalized",
        };
      }
    })
  );
}

/**
 * @notice Return all non-finalized CCTPDeposit events with their attestations attached. Attestations will be undefined
 * if the attestationn "status" is not "ready".
 * @param senderAddresses List of sender addresses to filter the DepositForBurn query
 * @param sourceChainId  Chain ID where the Deposit was created.
 * @param destinationChainid Chain ID where the Deposit is being sent to.
 * @param l2ChainId Chain ID of the L2 chain involved in the CCTP deposit. This can be the same as the source chain ID,
 * which is the chain where the Deposit was created. This is used to identify whether the CCTP deposit is V1 or V2.
 * @param sourceEventSearchConfig
 */
export async function getAttestationsForCCTPDepositEvents(
  senderAddresses: string[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<AttestedCCTPDepositEvent[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const isMainnet = utils.chainIsProd(destinationChainId);
  const depositsWithStatus = await getCCTPDepositEventsWithStatus(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    sourceEventSearchConfig
  );

  // Temporary structs we'll need until we can derive V2 nonce hashes:
  const txnReceiptHashCount: { [hash: string]: number } = {};
  const dstProvider = getCachedProvider(destinationChainId);
  const { address, abi } = getCctpMessageTransmitter(l2ChainId, destinationChainId);
  const destinationMessageTransmitter = new ethers.Contract(address, abi, dstProvider);

  const attestedDeposits = await Promise.all(
    depositsWithStatus.map(async (deposit) => {
      // If deposit is already finalized, we won't change its attestation status:
      if (deposit.status === "finalized") {
        return deposit;
      }
      // Otherwise, update the deposit's status after loading its attestation.
      const { transactionHash } = deposit.log;
      const count = (txnReceiptHashCount[transactionHash] ??= 0);
      ++txnReceiptHashCount[transactionHash];

      const attestation = isCctpV2
        ? await _generateCCTPV2AttestationProof(deposit.sourceDomain, transactionHash, isMainnet)
        : await _generateCCTPAttestationProof(deposit.messageHash, isMainnet);

      // For V2 we now have the nonceHash and we can query whether the message has been processed.
      // We can remove this V2 custom logic once we can derive nonceHashes locally and filter out already "finalized"
      // deposits in getCCTPDepositEventsWithStatus().
      if (isCctpV2ApiResponse(attestation)) {
        const attestationForDeposit = attestation.messages[count];
        const processed = await _hasCCTPMessageBeenProcessed(
          attestationForDeposit.eventNonce,
          destinationMessageTransmitter
        );
        if (processed) {
          return {
            ...deposit,
            status: "finalized" as CCTPMessageStatus,
          };
        } else {
          return {
            ...deposit,
            // For CCTPV2, the message is different than the one emitted in the Deposit because it includes the nonce, and
            // we need the messageBytes to submit the receiveMessage call successfully. We don't overwrite the messageHash
            // because its not needed for V2
            nonceHash: attestationForDeposit.eventNonce,
            messageBytes: attestationForDeposit.message,
            attestation: attestationForDeposit?.attestation, // Will be undefined if status is "pending"
            status: _getPendingV2AttestationStatus(attestationForDeposit.status),
          };
        }
      } else {
        return {
          ...deposit,
          attestation: attestation?.attestation, // Will be undefined if status is "pending"
          status: _getPendingAttestationStatus(attestation.status),
        };
      }
    })
  );
  return attestedDeposits;
}

function _getPendingV2AttestationStatus(attestation: string): CCTPMessageStatus {
  return attestation === "pending_confirmation" ? "pending" : "ready";
}

function _getPendingAttestationStatus(attestation: string): CCTPMessageStatus {
  return attestation === "pending_confirmations" ? "pending" : "ready";
}

async function _hasCCTPMessageBeenProcessed(nonceHash: string, contract: ethers.Contract): Promise<boolean> {
  const resultingCall: BigNumber = await contract.callStatic.usedNonces(nonceHash);
  // If the resulting call is 1, the message has been processed. If it is 0, the message has not been processed.
  return (resultingCall ?? bnZero).toNumber() === 1;
}

function _decodeCCTPV1Message(message: { data: string }): CCTPDeposit {
  // Source: https://developers.circle.com/stablecoins/message-format
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // sourceDomain 4 bytes starting index 4
  const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // destinationDomain 4 bytes starting index 8
  const nonce = BigNumber.from(ethers.utils.hexlify(messageBytesArray.slice(12, 20))).toNumber(); // nonce 8 bytes starting index 12
  // V1 nonce hash is a simple hash of the nonce emitted in Deposit event with the source domain ID.
  const nonceHash = ethers.utils.keccak256(ethers.utils.solidityPack(["uint32", "uint64"], [sourceDomain, nonce])); //
  const recipient = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(152, 184))); // recipient 32 bytes starting index 152 (idx 36 of body after idx 116 which ends the header)
  const amount = ethers.utils.hexlify(messageBytesArray.slice(184, 216)); // amount 32 bytes starting index 184 (idx 68 of body after idx 116 which ends the header)
  const sender = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(216, 248))); // sender 32 bytes starting index 216 (idx 100 of body after idx 116 which ends the header)

  return {
    nonceHash,
    amount: BigNumber.from(amount).toString(),
    sourceDomain,
    destinationDomain,
    sender,
    recipient,
    messageHash: ethers.utils.keccak256(messageBytes),
    messageBytes,
  };
}

function _decodeCCTPV2Message(message: { data: string; transactionHash: string; logIndex: number }): CCTPDeposit {
  // Source: https://developers.circle.com/stablecoins/message-format
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // sourceDomain 4 bytes starting index 4
  const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // destinationDomain 4 bytes starting index 8
  const recipient = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(184, 216))); // recipient 32 bytes starting index 184 (idx 36 of body after idx 148 which ends the header)
  const amount = ethers.utils.hexlify(messageBytesArray.slice(216, 248)); // amount 32 bytes starting index 216 (idx 68 of body after idx 148 which ends the header)
  const sender = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(248, 280))); // sender 32 bytes starting index 248 (idx 100 of body after idx 148 which ends the header)

  return {
    // Nonce is hardcoded to bytes32(0) in the V2 DepositForBurn event, so we either need to compute it here or get it
    // the API service. For now, we cannot compute it here as Circle will not disclose the hashing algorithm.
    nonceHash: ethers.constants.HashZero,
    amount: BigNumber.from(amount).toString(),
    sourceDomain,
    destinationDomain,
    sender,
    recipient,
    messageHash: ethers.utils.keccak256(messageBytes),
    messageBytes,
  };
}

/**
 * Generates an attestation proof for a given message hash. This is required to finalize a CCTP message.
 * @param messageHash The message hash to generate an attestation proof for. This is generated by taking the keccak256 hash of the message bytes of the initial transaction log.
 * @param isMainnet Whether or not the attestation proof should be generated on mainnet. If this is false, the attestation proof will be generated on the sandbox environment.
 * @returns The attestation status and proof for the given message hash. This is a string of the form "0x<attestation proof>". If the status is pending_confirmation
 * then the proof will be null according to the CCTP dev docs.
 * @link https://developers.circle.com/stablecoins/reference/getattestation
 */
async function _generateCCTPAttestationProof(
  messageHash: string,
  isMainnet: boolean
): Promise<CCTPAPIGetAttestationResponse> {
  const httpResponse = await axios.get<CCTPAPIGetAttestationResponse>(
    `https://iris-api${isMainnet ? "" : "-sandbox"}.circle.com/attestations/${messageHash}`
  );
  const attestationResponse = httpResponse.data;
  return attestationResponse;
}

// @todo: We can pass in a nonceHash here once we know how to recreate the nonceHash.
async function _generateCCTPV2AttestationProof(
  sourceDomainId: number,
  transactionHash: string,
  isMainnet: boolean
): Promise<CCTPV2APIGetAttestationResponse> {
  const httpResponse = await axios.get<CCTPV2APIGetAttestationResponse>(
    `https://iris-api${
      isMainnet ? "" : "-sandbox"
    }.circle.com/v2/messages/${sourceDomainId}?transactionHash=${transactionHash}`
  );
  return httpResponse.data;
}
