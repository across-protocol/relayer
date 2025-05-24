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
import { assert } from ".";

type CommonMessageData = {
  version: number; // 0 == v1, 1 == v2. This is how Circle assigns them
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;

  messageHash: string;
  messageBytes: string;
  nonceHash: string;
};
// Common data + auxilary data from depositForBurn event
type DepositForBurnMessageData = CommonMessageData & { amount: string; mintRecipient: string; burnToken: string };
type CommonMessageEvent = CommonMessageData & { log: Log };
type DepositForBurnMessageEvent = DepositForBurnMessageData & { log: Log };

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
export type CCTPMessageEvent = CommonMessageEvent | DepositForBurnMessageEvent;
export type AttestedCCTPMessageEvent = CCTPMessageEvent & { status: CCTPMessageStatus; attestation?: string };
function isDepositForBurnMessageEvent(event: CCTPMessageEvent): event is DepositForBurnMessageEvent {
  return "amount" in event && "mintRecipient" in event && "burnToken" in event;
}

const CCTP_MESSAGE_SENT_TOPIC_HASH = ethers.utils.id("MessageSent(bytes)");
// TODO: check these
const CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V1 = ethers.utils.id(
  "DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32)"
);
const CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V2 = ethers.utils.id(
  "DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)"
);

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

async function getCCTPMessageEvents(
  senderAddresses: string[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<CCTPMessageEvent[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const srcProvider = getCachedProvider(sourceChainId);

  // Step 1: Get all HubPool MessageRelayed and TokensRelayed events
  const hubPoolAddress = CONTRACT_ADDRESSES[sourceChainId]["hubPool"]?.address;
  if (!hubPoolAddress) {
    throw new Error(`No HubPool address found for chainId: ${sourceChainId}`);
  }

  const hubPool = new Contract(hubPoolAddress, require("../common/abi/HubPool.json"), srcProvider);

  const messageRelayedFilter = hubPool.filters.MessageRelayed();
  const messageRelayedEvents = await paginatedEventQuery(hubPool, messageRelayedFilter, sourceEventSearchConfig);

  const tokensRelayedFilter = hubPool.filters.TokensRelayed();
  const tokensRelayedEvents = await paginatedEventQuery(hubPool, tokensRelayedFilter, sourceEventSearchConfig);

  const uniqueTxHashes = new Set([
    ...messageRelayedEvents.map((e) => e.transactionHash),
    ...tokensRelayedEvents.map((e) => e.transactionHash),
  ]);

  if (uniqueTxHashes.size === 0) {
    return [];
  }

  const receipts = await Promise.all(Array.from(uniqueTxHashes).map((hash) => srcProvider.getTransactionReceipt(hash)));

  const _isMessageSentEvent = (log: ethers.providers.Log): boolean => {
    return log.topics[0] === CCTP_MESSAGE_SENT_TOPIC_HASH;
  };

  // returns 0 for v1 `DepositForBurn` event, 1 for v2, -1 for other events
  const _getDepositForBurnVersion = (log: ethers.providers.Log): number => {
    const topic = log.topics[0];
    switch (topic) {
      case CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V1:
        return 0;
      case CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V2:
        return 1;
      default:
        return -1;
    }
  };

  const sourceDomainId = getCctpDomainForChainId(sourceChainId);
  const destinationDomainId = getCctpDomainForChainId(destinationChainId);
  // TODO: how come does `usdcAddress` have type `string` here? What if there's no `sourceChainId` entry?
  const usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId];
  assert(isDefined(usdcAddress), `USDC address not defined for chain ${sourceChainId}`);

  const _isRelevantEvent = (event: CCTPMessageEvent): boolean => {
    const baseConditions =
      event.sourceDomain === sourceDomainId &&
      event.destinationDomain === destinationDomainId &&
      senderAddresses.some((sender) => compareAddressesSimple(sender, event.sender));

    return (
      baseConditions &&
      (!isDepositForBurnMessageEvent(event) ||
        // if DepositForBurnMessageEvent, check token too
        compareAddressesSimple(event.burnToken, usdcAddress))
    );
  };

  const relevantEvents: CCTPMessageEvent[] = [];
  const _addCommonMessageEventIfRelevant = (log: ethers.providers.Log) => {
    const eventData = isCctpV2 ? _decodeCommonMessageDataV1(log) : _decodeCommonMessageDataV2(log);
    const event: CommonMessageEvent = {
      ...eventData,
      log: log as Log,
    };
    if (_isRelevantEvent(event)) {
      relevantEvents.push(event);
    }
  };
  for (const receipt of receipts) {
    let lastMessageSentEventIdx = -1;
    let i = 0;
    for (const log of receipt.logs) {
      if (_isMessageSentEvent(log)) {
        if (lastMessageSentEventIdx == -1) {
          lastMessageSentEventIdx = i;
        } else {
          _addCommonMessageEventIfRelevant(log);
        }
      } else {
        const logCctpVersion = _getDepositForBurnVersion(log);
        if (logCctpVersion == -1) {
          // skip non-`DepositForBurn` events
          continue;
        }

        const matchingCctpVersion = (logCctpVersion == 0 && !isCctpV2) || (logCctpVersion == 1 && isCctpV2);
        if (matchingCctpVersion) {
          // if DepositForBurn event matches our "desired version", assess if it matches our search parameters
          const correspondingMessageSentLog = receipt.logs[lastMessageSentEventIdx];
          const eventData = isCctpV2
            ? _decodeDepositForBurnMessageDataV2(correspondingMessageSentLog)
            : _decodeDepositForBurnMessageDataV1(correspondingMessageSentLog);
          const event: DepositForBurnMessageEvent = {
            ...eventData,
            // TODO: how to turn ethers.providers.Log into Log ???? :((((
            // ! todo. This will not work. But do we even need log here?
            log: log as Log,
          };
          if (_isRelevantEvent(event)) {
            // TODO: Check correspondence between DepositForBurn and MessageSent events
            // TODO: how to turn ethers.providers.Log into Log ???? :((((
            relevantEvents.push(event);
          }
          lastMessageSentEventIdx = -1;
        } else {
          // reset `lastMessageSentEventIdx`, because we found a matching `DepositForBurn` event
          lastMessageSentEventIdx = -1;
        }
      }
      i += 1;
    }
    // After the loop over all logs, we might have an unmatched `MessageSent` event. Try to add it to `relevantEvents`
    if (lastMessageSentEventIdx != -1) {
      _addCommonMessageEventIfRelevant(receipt.logs[lastMessageSentEventIdx]);
    }
  }

  return relevantEvents;
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
          status: "pending", // We'll flip to ready once we get the attestation.
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

function _decodeCommonMessageDataV1(message: { data: string }): CommonMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // sourceDomain 4 bytes starting index 4
  const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // destinationDomain 4 bytes starting index 8
  const nonce = BigNumber.from(ethers.utils.hexlify(messageBytesArray.slice(12, 20))).toNumber(); // nonce 8 bytes starting index 12
  const sender = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(20, 52))); // sender	20	bytes32	32	Address of MessageTransmitter caller on source domain
  const recipient = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(52, 84))); // recipient	52	bytes32	32	Address to handle message body on destination domain

  // V1 nonce hash is a simple hash of the nonce emitted in Deposit event with the source domain ID.
  const nonceHash = ethers.utils.keccak256(ethers.utils.solidityPack(["uint32", "uint64"], [sourceDomain, nonce]));

  return {
    version: 0,
    sourceDomain,
    destinationDomain,
    sender,
    recipient,
    nonceHash,
    messageHash: ethers.utils.keccak256(messageBytes),
    messageBytes,
  };
}

function _decodeCommonMessageDataV2(message: { data: string }): CommonMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // sourceDomain 4 bytes starting index 4
  const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // destinationDomain 4 bytes starting index 8
  const sender = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(44, 76))); // sender	44	bytes32	32	Address of MessageTransmitterV2 caller on source domain
  const recipient = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(76, 108))); // recipient	76	bytes32	32	Address to handle message body on destination domain

  return {
    version: 0,
    sourceDomain,
    destinationDomain,
    sender,
    recipient,
    // For v2, we rely on Circle's API to find nonceHash
    nonceHash: ethers.constants.HashZero,
    messageHash: ethers.utils.keccak256(messageBytes),
    messageBytes,
  };
}

function _decodeDepositForBurnMessageDataV1(message: { data: string }): DepositForBurnMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const commonDataV1 = _decodeCommonMessageDataV1(message);
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  // Values specific to `DepositForBurn`. These are values contained withing `messageBody` bytes (the last of the message.data fields)
  const burnToken = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(120, 152))); // burnToken 4 bytes32 32 Address of burned token on source domain
  const mintRecipient = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(152, 184))); // mintRecipient 32 bytes starting index 152 (idx 36 of body after idx 116 which ends the header)
  const amount = ethers.utils.hexlify(messageBytesArray.slice(184, 216)); // amount 32 bytes starting index 184 (idx 68 of body after idx 116 which ends the header)
  const sender = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(216, 248))); // sender 32 bytes starting index 216 (idx 100 of body after idx 116 which ends the header)

  return {
    ...commonDataV1,
    burnToken,
    amount: BigNumber.from(amount).toString(),
    // override sender and recipient from `DepositForBurn`-specific values
    sender: sender,
    recipient: mintRecipient,
    mintRecipient,
  };
}

function _decodeDepositForBurnMessageDataV2(message: { data: string }): DepositForBurnMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const commonData = _decodeCommonMessageDataV2(message);
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  const burnToken = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(152, 184))); // burnToken: Address of burned token on source domain. 32 bytes starting index 152 (idx 4 of body after idx 148 which ends the header)
  const mintRecipient = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(184, 216))); // recipient 32 bytes starting index 184 (idx 36 of body after idx 148 which ends the header)
  const amount = ethers.utils.hexlify(messageBytesArray.slice(216, 248)); // amount 32 bytes starting index 216 (idx 68 of body after idx 148 which ends the header)
  const sender = cctpBytes32ToAddress(ethers.utils.hexlify(messageBytesArray.slice(248, 280))); // sender 32 bytes starting index 248 (idx 100 of body after idx 148 which ends the header)

  return {
    ...commonData,
    burnToken,
    amount: BigNumber.from(amount).toString(),
    // override sender and recipient from `DepositForBurn`-specific values
    sender: sender,
    recipient: mintRecipient,
    mintRecipient,
  };
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
