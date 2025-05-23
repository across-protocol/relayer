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
type CommonCCTPMessageData = {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;
  messageBody: string;

  messageHash: string; // keccak of `messageBytes`
  messageBytes: string; // bytes emitted with `SentMessage` event. Marshalled version of all the data above and maybe more
};

// common data between v1 and v2 BurnMessage data
// Source https://developers.circle.com/stablecoins/message-format
type AuxiliaryBurnMessageData = {
  amount: string;
  mintRecipient: string;
};

type CCTPRawMessageData = CommonCCTPMessageData;
type CCTPBurnMessageData = CommonCCTPMessageData & AuxiliaryBurnMessageData;

type CCTPRawMessageEvent = CCTPRawMessageData & { log: Log };
type CCTPBurnMessageEvent = CCTPBurnMessageData & { log: Log };

type CCTPRawMessage = CCTPRawMessageEvent & { nonceHash: string };
type CCTPBurnMessage = CCTPBurnMessageEvent & { nonceHash: string };
type CCTPMessage = CCTPRawMessage | CCTPBurnMessage;

type AttestedCCTPMessage = CCTPMessage & { status: CCTPMessageStatus; attestation?: string };
type AttestedCCTPBurnMessage = CCTPBurnMessage & { status: CCTPMessageStatus; attestation?: string };

type CCTPDeposit = {
  nonceHash: string;
  amount: string;
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;
  messageHash: string; // keccak of `messageBytes`
  messageBytes: string;
};
export type CCTPDepositEvent = CCTPDeposit & { log: Log };

// TODO: adjust this mb.
type CCTPMessageSent = {
  nonceHash: string;
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;
  messageHash: string; // keccak of `messageBytes`
  messageBytes: string;
};
// TODO: Not sure we need this type, idk
type CCTPMessageSentEvent = CCTPMessageSent & { log: Log };
type CCTPEvent = CCTPDepositEvent | CCTPMessageSentEvent;
export function isDepositEvent(event: CCTPEvent): event is CCTPDepositEvent {
  return "amount" in event;
}

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
export type AttestedCCTPEvent = CCTPEvent & { log: Log; status: CCTPMessageStatus; attestation?: string };
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
): Promise<CCTPEvent[]> {
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

  const cctpEvents: CCTPEvent[] = [];

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
        const depositEvent = _processDepositEvent(
          messageSentEvent,
          depositForBurnEvent,
          isCctpV2,
          sourceChainId,
          destinationChainId
        );
        if (depositEvent) {
          cctpEvents.push(depositEvent);
        }
      } else {
        // This is a pure message event
        const messageEvent = _processMessageEvent(messageSentEvent, isCctpV2, sourceChainId, destinationChainId);
        if (messageEvent) {
          cctpEvents.push(messageEvent);
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
 * @returns CCTPDepositEvent or null if invalid
 */
function _processDepositEvent(
  messageSentEvent: ethers.providers.Log,
  depositForBurnEvent: ethers.providers.Log,
  isCctpV2: boolean,
  sourceChainId: number,
  destinationChainId: number
): CCTPDepositEvent | null {
  try {
    const {
      sender: decodedSender,
      nonceHash,
      amount: decodedAmount,
      sourceDomain: decodedSourceDomain,
      destinationDomain: decodedDestinationDomain,
      recipient: decodedRecipient,
      messageHash,
      messageBytes,
    } = isCctpV2 ? _decodeCCTPV2Message(messageSentEvent) : _decodeCCTPV1Message(messageSentEvent);

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
      !compareAddressesSimple(decodedSender, parsedDepositForBurnLog.args.depositor) ||
      !compareAddressesSimple(decodedRecipient, cctpBytes32ToAddress(parsedDepositForBurnLog.args.mintRecipient)) ||
      !BigNumber.from(decodedAmount).eq(parsedDepositForBurnLog.args.amount) ||
      decodedSourceDomain !== getCctpDomainForChainId(sourceChainId) ||
      decodedDestinationDomain !== getCctpDomainForChainId(destinationChainId)
    ) {
      return null;
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
      log: parsedDepositForBurnLog,
    };
  } catch (error) {
    return null;
  }
}

/**
 * @notice Processes a MessageSent event that does not have an accompanying DepositForBurn event
 * @param messageSentEvent The MessageSent event log (raw Ethers log)
 * @param isCctpV2 Whether this is CCTP V2
 * @param sourceChainId Source chain ID
 * @param destinationChainId Destination chain ID
 * @returns CCTPMessageSentEvent or null if invalid
 */
function _processMessageEvent(
  messageSentEvent: ethers.providers.Log,
  isCctpV2: boolean,
  sourceChainId: number, // This is the chain where the MessageSent event originated
  destinationChainId: number
): CCTPMessageSentEvent | null {
  try {
    const {
      sender: decodedSender,
      nonceHash,
      sourceDomain: decodedSourceDomain,
      destinationDomain: decodedDestinationDomain,
      recipient: decodedRecipient,
      messageHash,
      messageBytes,
    } = isCctpV2 ? _decodeCCTPV2Message(messageSentEvent) : _decodeCCTPV1Message(messageSentEvent);

    if (
      decodedSourceDomain !== getCctpDomainForChainId(sourceChainId) ||
      decodedDestinationDomain !== getCctpDomainForChainId(destinationChainId)
    ) {
      return null;
    }

    // The MessageTransmitter contract and its ABI (for parsing MessageSent) should correspond to the sourceChainId.
    // The l2ChainId parameter was used in getCctpMessageTransmitter to decide between V1 and V2 ABI *versions*,
    // but for MessageSent, the ABI is consistent. The address of the MessageTransmitter is on sourceChainId.
    const { abi: messageTransmitterAbi } = getCctpMessageTransmitter(
      sourceChainId, // Use sourceChainId to determine which chain's MessageTransmitter we are dealing with
      sourceChainId // And again for the ABI (though version difference is not an issue for MessageSent ABI itself)
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
      nonceHash,
      sourceDomain: decodedSourceDomain,
      destinationDomain: decodedDestinationDomain,
      sender: decodedSender,
      recipient: decodedRecipient,
      messageHash,
      messageBytes,
      log: parsedMessageSentLog,
    };
  } catch (error) {
    return null;
  }
}

export async function getCCTPDepositEvents(
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

/**
 * @notice Return all CCTP events (both deposit and message events) with their attestations attached.
 * Attestations will be undefined if the attestation "status" is not "ready".
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
): Promise<AttestedCCTPEvent[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const isMainnet = utils.chainIsProd(destinationChainId);
  const allEvents = await getCCTPEvents(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    sourceEventSearchConfig
  );

  const eventsWithStatus = await _addStatusToCCTPEvents(allEvents, l2ChainId, destinationChainId);

  // Temporary structs we'll need until we can derive V2 nonce hashes:
  const txnReceiptHashCount: { [hash: string]: number } = {};
  const dstProvider = getCachedProvider(destinationChainId);
  const { address, abi } = getCctpMessageTransmitter(l2ChainId, destinationChainId);
  const destinationMessageTransmitter = new ethers.Contract(address, abi, dstProvider);

  const attestedEvents = await Promise.all(
    eventsWithStatus.map(async (event) => {
      // If event is already finalized, we won't change its attestation status:
      if (event.status === "finalized") {
        return event;
      }
      // Otherwise, update the event's status after loading its attestation.
      const { transactionHash } = event.log;
      const count = (txnReceiptHashCount[transactionHash] ??= 0);
      ++txnReceiptHashCount[transactionHash];

      const attestation = isCctpV2
        ? await _generateCCTPV2AttestationProof(event.sourceDomain, transactionHash, isMainnet)
        : await _generateCCTPAttestationProof(event.messageHash, isMainnet);

      // For V2 we now have the nonceHash and we can query whether the message has been processed.
      if (isCctpV2ApiResponse(attestation)) {
        const attestationForEvent = attestation.messages[count];
        const processed = await _hasCCTPMessageBeenProcessed(
          attestationForEvent.eventNonce,
          destinationMessageTransmitter
        );
        if (processed) {
          return {
            ...event,
            status: "finalized" as CCTPMessageStatus,
          };
        } else {
          return {
            ...event,
            // For CCTPV2, the message is different than the one emitted in the Deposit because it includes the nonce, and
            // we need the messageBytes to submit the receiveMessage call successfully. We don't overwrite the messageHash
            // because its not needed for V2
            nonceHash: attestationForEvent.eventNonce,
            messageBytes: attestationForEvent.message,
            attestation: attestationForEvent?.attestation, // Will be undefined if status is "pending"
            status: _getPendingV2AttestationStatus(attestationForEvent.status),
          };
        }
      } else {
        return {
          ...event,
          attestation: attestation?.attestation, // Will be undefined if status is "pending"
          status: _getPendingAttestationStatus(attestation.status),
        };
      }
    })
  );
  return attestedEvents;
}

/**
 * @notice Adds status information to CCTP events
 * @param events The CCTP events to add status to
 * @param l2ChainId L2 chain ID to determine V1 vs V2
 * @param destinationChainId Destination chain ID
 * @returns Events with status information added
 */
async function _addStatusToCCTPEvents(
  events: CCTPEvent[],
  l2ChainId: number,
  destinationChainId: number
): Promise<AttestedCCTPEvent[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const dstProvider = getCachedProvider(destinationChainId);
  const { address, abi } = getCctpMessageTransmitter(l2ChainId, destinationChainId);
  const destinationMessageTransmitter = new ethers.Contract(address, abi, dstProvider);

  return await Promise.all(
    events.map(async (event) => {
      // @dev Currently we have no way to recreate the V2 nonce hash until after we've received the attestation,
      // so skip this step for V2 since we have no way of knowing whether the message is finalized until after we
      // query the Attestation API service.
      if (isCctpV2) {
        return {
          ...event,
          status: "pending" as CCTPMessageStatus,
        };
      }

      // For deposit events, we already have the nonceHash from decoding
      // For message events in V1, we need to extract it from the decoded message
      let nonceHash: string;
      if (isDepositEvent(event)) {
        nonceHash = event.nonceHash;
      } else {
        // For V1 message events, we need to decode the message to get the nonce
        const decodedMessage = _decodeCCTPV1Message(event.log);
        nonceHash = decodedMessage.nonceHash;
      }

      const processed = await _hasCCTPMessageBeenProcessed(nonceHash, destinationMessageTransmitter);
      if (!processed) {
        return {
          ...event,
          status: "pending" as CCTPMessageStatus, // We'll flip to ready once we get the attestation
        };
      } else {
        return {
          ...event,
          status: "finalized" as CCTPMessageStatus,
        };
      }
    })
  );
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
): Promise<AttestedCCTPDepositEvent[]> {
  const allEvents = await getAttestationsForCCTPEvents(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    sourceEventSearchConfig
  );

  // Filter to only return deposit events for backward compatibility.
  // The explicit type predicate in the lambda helps TypeScript correctly infer the narrowed type.
  return allEvents.filter((event: AttestedCCTPEvent): event is AttestedCCTPDepositEvent => isDepositEvent(event));
}
