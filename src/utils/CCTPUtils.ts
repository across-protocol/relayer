import { utils } from "@across-protocol/sdk";
import { PUBLIC_NETWORKS, CHAIN_IDs, TOKEN_SYMBOLS_MAP, CCTP_NO_DOMAIN } from "@across-protocol/constants";
import axios from "axios";
import { Contract, ethers } from "ethers";
import { LogDescription } from "ethers/lib/utils";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumber } from "./BNUtils";
import { bnZero, compareAddressesSimple } from "./SDKUtils";
import { isDefined } from "./TypeGuards";
import { getCachedProvider } from "./ProviderUtils";
import { EventSearchConfig, paginatedEventQuery } from "./EventUtils";
import { findLast } from "lodash";
import { Log } from "../interfaces";

// common message data between v1 and v2 that is actually used in upstream finalizers that can be decoded from `SentMessage` event.
// Source https://developers.circle.com/stablecoins/message-format
type CommonMessageData = {
  version: number; // CCTP message version (0 for V1, 1 for V2 from header)
  sourceDomain: number;
  destinationDomain: number;
  sender: string; // CCTP message sender (from header)
  recipient: string; // CCTP message recipient (from header)
  messageBody: string; // Raw message body hex string

  messageHash: string; // keccak of `messageBytes`
  messageBytes: string; // bytes emitted with `SentMessage` event. Marshalled version of all the data above and maybe more
  // For V1, const nonceHash = ethers.utils.keccak256(ethers.utils.solidityPack(["uint32", "uint64"], [sourceDomain, nonce]));
  // For V2, this will be the eventNonce from Circle API, initially might be zero.
  nonceHash: string;
};

// common data between v1 and v2 BurnMessage data, parsed from messageBody
// Source https://developers.circle.com/stablecoins/message-format
type AuxiliaryBurnMessageData = {
  amount: string;
  mintRecipient: string; // User's address on destination chain
  messageSender: string; // Original user/contract that initiated the burn (from burn message body)
};

type RawMessageData = CommonMessageData;
type BurnMessageData = CommonMessageData & AuxiliaryBurnMessageData;

type RawMessageEvent = RawMessageData & { log: Log }; // For generic CCTP messages
type BurnMessageEvent = BurnMessageData & { log: Log }; // For CCTP messages that include a burn/mint operation

type MessageEvent = RawMessageEvent | BurnMessageEvent;

export function isBurnMessageEvent(message: MessageEvent): message is BurnMessageEvent {
  return (message as BurnMessageEvent).amount !== undefined;
}

export type AttestedCCTPMessage = MessageEvent & { status: CCTPMessageStatus; attestation?: string };
export type AttestedCCTPBurnMessage = BurnMessageEvent & { status: CCTPMessageStatus; attestation?: string };

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

/**
 * @notice Get all CCTP events (both deposit and message events) from HubPool transactions.
 * This function looks for MessageRelayed and TokensRelayed events from the HubPool, then finds the
 * corresponding CCTP MessageSent events in those transactions, and classifies them as either
 * deposit events (with accompanying DepositForBurn) or pure message events.
 * @param senderAddresses List of sender addresses to filter events
 * @param sourceChainId Chain ID where the events were created.
 * @param destinationChainId Chain ID where the events are being sent to.
 * @param l2ChainId Chain ID of the L2 chain involved in the CCTP events. Used to identify V1 vs V2.
 * @param sourceEventSearchConfig Event search configuration
 * @returns Array of CCTPEvent objects (both deposit and message events)
 */
export async function getCCTPEvents(
  senderAddresses: string[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<MessageEvent[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const srcProvider = getCachedProvider(sourceChainId);

  // Step 1: Get all HubPool MessageRelayed and TokensRelayed events
  const hubPoolAddress = CONTRACT_ADDRESSES[sourceChainId]["hubPool"]?.address;
  if (!hubPoolAddress) {
    throw new Error(`No HubPool address found for chainId: ${sourceChainId}`);
  }

  const hubPool = new Contract(hubPoolAddress, require("../common/abi/HubPool.json"), srcProvider);

  // Get MessageRelayed events (pure messages)
  const messageRelayedFilter = hubPool.filters.MessageRelayed();
  const messageRelayedEvents = await paginatedEventQuery(hubPool, messageRelayedFilter, sourceEventSearchConfig);

  // Get TokensRelayed events (token transfers)
  const tokensRelayedFilter = hubPool.filters.TokensRelayed();
  const tokensRelayedEvents = await paginatedEventQuery(hubPool, tokensRelayedFilter, sourceEventSearchConfig);

  // Step 2: Get unique transaction hashes
  const uniqueTxHashes = new Set([
    ...messageRelayedEvents.map((e) => e.transactionHash),
    ...tokensRelayedEvents.map((e) => e.transactionHash),
  ]);

  if (uniqueTxHashes.size === 0) {
    return [];
  }

  // Step 3: Get receipts for all transactions
  const receipts = await Promise.all(Array.from(uniqueTxHashes).map((hash) => srcProvider.getTransactionReceipt(hash)));

  const cctpEvents: MessageEvent[] = [];

  // Step 4: Process each receipt to identify CCTP events
  for (const receipt of receipts) {
    // Find all MessageSent events in this transaction
    const messageSentEvents = receipt.logs.filter((log) => log.topics[0] === CCTP_MESSAGE_SENT_TOPIC_HASH);

    for (const messageSentEvent of messageSentEvents) {
      // Check if this MessageSent event is followed by a DepositForBurn event in the same transaction
      const depositForBurnEvent = findLast(
        receipt.logs,
        (l) => _isDepositForBurnEvent(l, isCctpV2, sourceChainId) && l.logIndex > messageSentEvent.logIndex
      );

      if (depositForBurnEvent) {
        // This is a token deposit event - process like existing DepositForBurn events
        const burnMessage = _processBurnMessageEvent(
          messageSentEvent,
          depositForBurnEvent,
          isCctpV2,
          sourceChainId,
          destinationChainId
        );
        if (burnMessage) {
          cctpEvents.push(burnMessage);
        }
      } else {
        // This is a pure message event
        const rawMessage = _processRawMessageEvent(messageSentEvent, isCctpV2, sourceChainId, destinationChainId);
        if (rawMessage) {
          cctpEvents.push(rawMessage);
        }
      }
    }
  }

  return cctpEvents;
}

/**
 * @notice Checks if a log is a DepositForBurn event
 * @param log The log to check
 * @param isCctpV2 Whether this is CCTP V2
 * @param chainId The chain ID for contract address lookup
 * @returns True if the log is a DepositForBurn event
 */
function _isDepositForBurnEvent(log: ethers.providers.Log, isCctpV2: boolean, chainId: number): boolean {
  const { address: tokenMessengerAddress, abi } = getCctpTokenMessenger(isCctpV2 ? CHAIN_IDs.LINEA : chainId, chainId);

  if (!tokenMessengerAddress || !abi || log.address.toLowerCase() !== tokenMessengerAddress.toLowerCase()) {
    return false;
  }

  try {
    const iface = new ethers.utils.Interface(abi as ReadonlyArray<string | ethers.utils.Fragment>);
    const parsedLog = iface.parseLog(log);
    return parsedLog.name === "DepositForBurn";
  } catch (e) {
    return false;
  }
}

/**
 * @notice Processes a MessageSent event that has an accompanying DepositForBurn event
 * @param messageSentEvent The MessageSent event log (raw Ethers log)
 * @param depositForBurnEvent The DepositForBurn event log (raw Ethers log)
 * @param isCctpV2 Whether this is CCTP V2
 * @param sourceChainId Source chain ID
 * @param destinationChainId Destination chain ID
 * @returns CCTPBurnMessageEvent or null if invalid
 */
function _processBurnMessageEvent(
  messageSentEvent: ethers.providers.Log,
  depositForBurnEvent: ethers.providers.Log,
  isCctpV2: boolean,
  sourceChainId: number,
  destinationChainId: number
): BurnMessageEvent | null {
  try {
    const commonData = isCctpV2
      ? _decodeCommonCCTPMessageV2(ethers.utils.defaultAbiCoder.decode(["bytes"], messageSentEvent.data)[0])
      : _decodeCommonCCTPMessageV1(ethers.utils.defaultAbiCoder.decode(["bytes"], messageSentEvent.data)[0]);

    const auxData = _decodeAuxiliaryBurnMessageData(commonData.messageBody, isCctpV2);

    const { address: tokenMessengerAddress, abi: tokenMessengerAbi } = getCctpTokenMessenger(
      isCctpV2 ? CHAIN_IDs.LINEA : sourceChainId,
      sourceChainId
    );

    if (!tokenMessengerAddress || !tokenMessengerAbi) {
      return null;
    }
    const tokenMessengerInterface = new ethers.utils.Interface(
      tokenMessengerAbi as ReadonlyArray<string | ethers.utils.Fragment>
    );
    const parsedLogDescription: LogDescription = tokenMessengerInterface.parseLog(depositForBurnEvent);
    const parsedDepositForBurnLog: Log = {
      ...depositForBurnEvent,
      event: parsedLogDescription.name,
      args: parsedLogDescription.args,
    };

    if (
      !compareAddressesSimple(auxData.messageSender, parsedDepositForBurnLog.args.depositor) ||
      !compareAddressesSimple(
        auxData.mintRecipient,
        cctpBytes32ToAddress(parsedDepositForBurnLog.args.mintRecipient)
      ) ||
      !BigNumber.from(auxData.amount).eq(parsedDepositForBurnLog.args.amount) ||
      commonData.sourceDomain !== getCctpDomainForChainId(sourceChainId) ||
      commonData.destinationDomain !== getCctpDomainForChainId(destinationChainId)
    ) {
      return null;
    }

    return {
      ...commonData,
      ...auxData,
      log: parsedDepositForBurnLog,
    };
  } catch (error) {
    console.error("Error processing CCTP burn message event:", error);
    return null;
  }
}

/**
 * @notice Processes a MessageSent event that does not have an accompanying DepositForBurn event
 * @param messageSentEvent The MessageSent event log (raw Ethers log)
 * @param isCctpV2 Whether this is CCTP V2
 * @param sourceChainId Source chain ID
 * @param destinationChainId Destination chain ID
 * @returns CCTPRawMessageEvent or null if invalid
 */
function _processRawMessageEvent(
  messageSentEvent: ethers.providers.Log,
  isCctpV2: boolean,
  sourceChainId: number,
  destinationChainId: number
): RawMessageEvent | null {
  try {
    const commonData = isCctpV2
      ? _decodeCommonCCTPMessageV2(ethers.utils.defaultAbiCoder.decode(["bytes"], messageSentEvent.data)[0])
      : _decodeCommonCCTPMessageV1(ethers.utils.defaultAbiCoder.decode(["bytes"], messageSentEvent.data)[0]);

    if (
      commonData.sourceDomain !== getCctpDomainForChainId(sourceChainId) ||
      commonData.destinationDomain !== getCctpDomainForChainId(destinationChainId)
    ) {
      return null;
    }

    const { abi: messageTransmitterAbi } = getCctpMessageTransmitter(
      isCctpV2 ? CHAIN_IDs.LINEA : sourceChainId,
      sourceChainId
    );

    if (!messageTransmitterAbi) {
      return null;
    }
    const messageTransmitterInterface = new ethers.utils.Interface(
      messageTransmitterAbi as ReadonlyArray<string | ethers.utils.Fragment>
    );
    const parsedLogDescription: LogDescription = messageTransmitterInterface.parseLog(messageSentEvent);
    const parsedMessageSentLog: Log = {
      ...messageSentEvent,
      event: parsedLogDescription.name,
      args: parsedLogDescription.args,
    };

    return {
      ...commonData,
      log: parsedMessageSentLog,
    };
  } catch (error) {
    console.error("Error processing raw CCTP message event:", error);
    return null;
  }
}

/**
 * @notice Return all CCTP messages (both burn and raw) with their attestations attached.
 * Attestations will be undefined if the attestation "status" is not "ready" or "finalized".
 * @param senderAddresses List of sender addresses to filter events
 * @param sourceChainId Chain ID where the events were created.
 * @param destinationChainId Chain ID where the events are being sent to.
 * @param l2ChainId Chain ID of the L2 chain involved in the CCTP events. Used to identify V1 vs V2.
 * @param sourceEventSearchConfig Event search configuration
 */
export async function getAttestationsForCCTPEvents(
  senderAddresses: string[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<AttestedCCTPMessage[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const isMainnet = utils.chainIsProd(destinationChainId);
  const allMessages = await getCCTPEvents(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    sourceEventSearchConfig
  );

  const messagesWithInitialStatus = await _addStatusToCCTPMessages(allMessages, l2ChainId, destinationChainId);

  // Temporary structs we'll need until we can derive V2 nonce hashes:
  const txnReceiptHashCount: { [hash: string]: number } = {};
  const dstProvider = getCachedProvider(destinationChainId);
  const { address, abi } = getCctpMessageTransmitter(l2ChainId, destinationChainId);
  const destinationMessageTransmitter = new ethers.Contract(address, abi, dstProvider);

  const attestedMessages = await Promise.all(
    messagesWithInitialStatus.map(async (message) => {
      // If event is already finalized, we won't change its attestation status:
      if (message.status === "finalized") {
        return message;
      }
      // Otherwise, update the event's status after loading its attestation.
      const { transactionHash } = message.log;
      const count = (txnReceiptHashCount[transactionHash] ??= 0);
      ++txnReceiptHashCount[transactionHash];

      const attestation = isCctpV2
        ? await _generateCCTPV2AttestationProof(message.sourceDomain, transactionHash, isMainnet)
        : await _generateCCTPAttestationProof(message.messageHash, isMainnet);

      // For V2 we now have the nonceHash and we can query whether the message has been processed.
      if (isCctpV2ApiResponse(attestation)) {
        const attestationForEvent = attestation.messages[count];
        // If no specific attestation found for this message in the bundle (e.g. API error or unexpected structure)
        if (!attestationForEvent) {
          return {
            ...message,
            status: "pending" as CCTPMessageStatus, // Keep status as pending if attestation is missing
          };
        }
        const processed = await _hasCCTPMessageBeenProcessed(
          attestationForEvent.eventNonce,
          destinationMessageTransmitter
        );
        if (processed) {
          return {
            ...message,
            nonceHash: attestationForEvent.eventNonce,
            status: "finalized" as CCTPMessageStatus,
          };
        } else {
          return {
            ...message,
            // For CCTPV2, the message is different than the one emitted in the Deposit because it includes the nonce, and
            // we need the messageBytes to submit the receiveMessage call successfully. We don't overwrite the messageHash
            // because its not needed for V2
            nonceHash: attestationForEvent.eventNonce,
            messageBytes: attestationForEvent.message,
            attestation: attestationForEvent?.attestation,
            status: _getPendingV2AttestationStatus(attestationForEvent.status),
          };
        }
      } else {
        // For V1, check if already processed using existing nonceHash
        const processed = await _hasCCTPMessageBeenProcessed(message.nonceHash, destinationMessageTransmitter);
        if (processed) {
          return { ...message, status: "finalized" as CCTPMessageStatus };
        }
        return {
          ...message,
          attestation: attestation?.attestation,
          status: _getPendingAttestationStatus(attestation.status),
        };
      }
    })
  );
  return attestedMessages;
}

/**
 * @notice Adds status information to CCTP messages
 * @param messages The CCTP messages to add status to
 * @param l2ChainId L2 chain ID to determine V1 vs V2 aspects (e.g. for transmitter contract version)
 * @param destinationChainId Destination chain ID for contract interactions
 * @returns Messages with status information added
 */
async function _addStatusToCCTPMessages(
  messages: MessageEvent[],
  l2ChainId: number,
  destinationChainId: number
): Promise<AttestedCCTPMessage[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const dstProvider = getCachedProvider(destinationChainId);
  const { address, abi } = getCctpMessageTransmitter(l2ChainId, destinationChainId);
  const destinationMessageTransmitter = new ethers.Contract(address, abi, dstProvider);

  return await Promise.all(
    messages.map(async (message) => {
      // For V2 messages, the nonceHash from decoding is initially zero.
      // The actual nonce (eventNonce) comes from the Circle API.
      // The check for `usedNonces` must use that API-provided nonce.
      // So, we defer the "finalized" check for V2 until after API call in getAttestationsForCCTPEvents.
      // The initial status for V2 messages will be 'pending'.
      if (isCctpV2) {
        return {
          ...message,
          status: "pending" as CCTPMessageStatus,
        };
      }

      // For V1 messages, message.nonceHash is derived during decoding.
      // We can check if it's already finalized.
      const processed = await _hasCCTPMessageBeenProcessed(message.nonceHash, destinationMessageTransmitter);
      if (!processed) {
        return {
          ...message,
          status: "pending" as CCTPMessageStatus, // We'll update to ready/finalized once we get/check attestation
        };
      } else {
        return {
          ...message,
          status: "finalized" as CCTPMessageStatus,
        };
      }
    })
  );
}

function _getPendingV2AttestationStatus(attestationStatusFromApi: string): CCTPMessageStatus {
  return attestationStatusFromApi === "pending_confirmation" ? "pending" : "ready";
}

function _getPendingAttestationStatus(attestationStatusFromApi: string): CCTPMessageStatus {
  return attestationStatusFromApi === "pending_confirmations" ? "pending" : "ready";
}

async function _hasCCTPMessageBeenProcessed(nonceHash: string, contract: ethers.Contract): Promise<boolean> {
  const resultingCall: BigNumber = await contract.callStatic.usedNonces(nonceHash);
  // If the resulting call is 1, the message has been processed. If it is 0, the message has not been processed.
  return (resultingCall ?? bnZero).toNumber() === 1;
}

/**
 * @notice Decodes CCTP V1 message header and raw message body.
 * @param rawMessageDataBytes Hex string of the message data from MessageSent event.
 * @returns CommonCCTPMessageData object.
 */
function _decodeCommonCCTPMessageV1(rawMessageDataBytes: string): CommonMessageData {
  const messageBytesArray = ethers.utils.arrayify(rawMessageDataBytes);

  // CCTP V1 Header (116 bytes total)
  // https://developers.circle.com/stablecoins/message-format (select CCTP V1 for Message Header)
  const version = Number(ethers.utils.hexlify(messageBytesArray.slice(0, 4))); // uint32, expected to be 0 for CCTP V1 msg
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // uint32
  const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // uint32
  const nonceV1 = BigNumber.from(ethers.utils.hexlify(messageBytesArray.slice(12, 20))).toNumber(); // uint64
  const sender = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(20, 52))); // bytes32
  const recipient = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(52, 84))); // bytes32
  // destinationCaller (bytes32) from 84 to 116 is not used in CommonCCTPMessageData

  const messageBody = ethers.utils.hexlify(messageBytesArray.slice(116));

  const nonceHash = ethers.utils.keccak256(ethers.utils.solidityPack(["uint32", "uint64"], [sourceDomain, nonceV1]));

  return {
    version,
    sourceDomain,
    destinationDomain,
    sender,
    recipient,
    messageBody,
    messageHash: ethers.utils.keccak256(rawMessageDataBytes),
    messageBytes: rawMessageDataBytes,
    nonceHash,
  };
}

/**
 * @notice Decodes CCTP V2 message header and raw message body.
 * @param rawMessageDataBytes Hex string of the message data from MessageSent event.
 * @returns CommonCCTPMessageData object.
 */
function _decodeCommonCCTPMessageV2(rawMessageDataBytes: string): CommonMessageData {
  const messageBytesArray = ethers.utils.arrayify(rawMessageDataBytes);

  // CCTP V2 Header (140 bytes total)
  // https://developers.circle.com/stablecoins/message-format (select CCTP V2 for Message Header)
  const version = Number(ethers.utils.hexlify(messageBytesArray.slice(0, 4))); // uint32, expected to be 1 for CCTP V2 msg
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // uint32
  const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // uint32
  // V2 nonce (bytes32) from 12 to 44. This is the message's unique identifier.
  // The `nonceHash` field in CommonCCTPMessageData will be populated with the `eventNonce`
  // from Circle's API response, so we initialize it to zero here.
  const sender = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(44, 76))); // bytes32
  const recipient = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(76, 108))); // bytes32
  // destinationCaller (bytes32) from 108 to 140 is not used in CommonCCTPMessageData

  const messageBody = ethers.utils.hexlify(messageBytesArray.slice(140));

  return {
    version,
    sourceDomain,
    destinationDomain,
    sender,
    recipient,
    messageBody,
    messageHash: ethers.utils.keccak256(rawMessageDataBytes),
    messageBytes: rawMessageDataBytes,
    nonceHash: ethers.constants.HashZero, // V2 nonceHash (eventNonce) comes from API
  };
}

/**
 * @notice Decodes auxiliary data (amount, mintRecipient, messageSender) from a CCTP BurnMessage body.
 * @param messageBodyHex Hex string of the CCTP messageBody.
 * @param _isCctpV2BurnMessageBody This parameter indicates if the burn message body conforms to V2 spec (e.g. for future fields).
 *                                For current fields (amount, mintRecipient, messageSender), V1 and V2 are similar.
 * @returns AuxiliaryBurnMessageData object.
 */
function _decodeAuxiliaryBurnMessageData(
  messageBodyHex: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _isCctpV2BurnMessageBody: boolean // Currently unused as relevant fields have same offsets
): AuxiliaryBurnMessageData {
  const messageBodyArray = ethers.utils.arrayify(messageBodyHex);

  // BurnMessage format (inside CCTP messageBody)
  // Common for V1 and V2 regarding these fields:
  // version (uint32) at offset 0 (4 bytes) - burn message format version
  // burnToken (bytes32) at offset 4 (32 bytes)
  const mintRecipient = cctpBytes32ToAddress(ethers.utils.hexlify(messageBodyArray.slice(36, 68))); // offset 36, length 32
  const amount = BigNumber.from(ethers.utils.hexlify(messageBodyArray.slice(68, 100))).toString(); // offset 68, length 32
  const messageSender = cctpBytes32ToAddress(ethers.utils.hexlify(messageBodyArray.slice(100, 132))); // offset 100, length 32

  return {
    mintRecipient,
    amount,
    messageSender,
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
  // Only leave v2 attestations in the response
  const filteredMessages = httpResponse.data.messages.filter((message) => message.cctpVersion === 2);
  return {
    messages: filteredMessages,
  };
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
): Promise<AttestedCCTPBurnMessage[]> {
  const allMessages = await getAttestationsForCCTPEvents(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    sourceEventSearchConfig
  );

  // Filter to only return burn messages (those with amount/mintRecipient) for backward compatibility for this specific function.
  // The explicit type predicate in the lambda helps TypeScript correctly infer the narrowed type.
  return allMessages.filter((message: AttestedCCTPMessage): message is AttestedCCTPBurnMessage =>
    isBurnMessageEvent(message)
  );
}
