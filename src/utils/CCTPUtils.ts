import { arch, utils } from "@across-protocol/sdk";
import { TokenMessengerMinterIdl } from "@across-protocol/contracts";
import { PUBLIC_NETWORKS, CHAIN_IDs, TOKEN_SYMBOLS_MAP, CCTP_NO_DOMAIN } from "@across-protocol/constants";
import axios from "axios";
import { Contract, ethers } from "ethers";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumber } from "./BNUtils";
import {
  bnZero,
  compareAddressesSimple,
  chainIsSvm,
  SvmCpiEventsClient,
  SvmAddress,
  mapAsync,
  chainIsProd,
  Address,
  EvmAddress,
} from "./SDKUtils";
import { isDefined } from "./TypeGuards";
import { getCachedProvider, getSvmProvider } from "./ProviderUtils";
import { EventSearchConfig, paginatedEventQuery, spreadEvent } from "./EventUtils";
import { Log } from "../interfaces";
import { assert, getRedisCache, Provider } from ".";
import { KeyPairSigner } from "@solana/kit";

type CommonMessageData = {
  // `cctpVersion` is nuanced. cctpVersion returned from API are 1 or 2 (v1 and v2 accordingly). The bytes responsible for a version within the message itself though are 0 or 1 (v1 and v2 accordingly) :\
  cctpVersion: number;
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;
  messageHash: string;
  messageBytes: string;
  nonce: number; // This nonce makes sense only for v1 events, as it's emitted on src chain send
  nonceHash: string;
};
// Common data + auxiliary data from depositForBurn event
type DepositForBurnMessageData = CommonMessageData & { amount: string; mintRecipient: string; burnToken: string };
type CommonMessageEvent = CommonMessageData & { log: Log };
type DepositForBurnMessageEvent = DepositForBurnMessageData & { log: Log };

type CCTPSvmAPIAttestation = {
  attestation: string;
  message: string;
  eventNonce: string;
};

type CCTPSvmAPIGetAttestationResponse = { messages: CCTPSvmAPIAttestation[] };
type CCTPAPIGetAttestationResponse = { status: string; attestation: string };
type CCTPV2APIAttestation = {
  status: string;
  attestation: string;
  message: string;
  eventNonce: string;
  cctpVersion: number;
};
type CCTPV2APIGetAttestationResponse = { messages: CCTPV2APIAttestation[] };

// Notice: minimal data included in the `DepositForBurn` event on the Solana side
type MinimalSvmDepositForBurnData = {
  // base58 encoding, 32 bytes string
  depositor: string;
  // just an int
  destinationDomain: number;
};

export type CCTPMessageStatus = "finalized" | "ready" | "pending";
export type CCTPMessageEvent = CommonMessageEvent | DepositForBurnMessageEvent;
export type AttestedCCTPMessage = CCTPMessageEvent & { status: CCTPMessageStatus; attestation?: string };
export type AttestedCCTPDeposit = DepositForBurnMessageEvent & { status: CCTPMessageStatus; attestation?: string };
export function isDepositForBurnEvent(event: CCTPMessageEvent): event is DepositForBurnMessageEvent {
  return "amount" in event && "mintRecipient" in event && "burnToken" in event;
}

const CCTP_MESSAGE_SENT_TOPIC_HASH = ethers.utils.id("MessageSent(bytes)");
const CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V1 = ethers.utils.id(
  "DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32)"
);
const CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V2 = ethers.utils.id(
  "DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)"
);

const CCTP_V2_L2_CHAINS = [CHAIN_IDs.LINEA, CHAIN_IDs.WORLD_CHAIN];

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
 * Creates and validates CCTP contract interfaces for TokenMessenger and MessageTransmitter contracts.
 * Asserts that the event topic hashes match expected values to ensure interface correctness.
 */
function getContractInterfaces(
  l2ChainId: number,
  sourceChainId: number,
  isCctpV2: boolean
): {
  tokenMessengerInterface: ethers.utils.Interface;
  messageTransmitterInterface: ethers.utils.Interface;
} {
  // Get contract ABIs
  const { abi: tokenMessengerAbi } = getCctpTokenMessenger(l2ChainId, sourceChainId);
  const { abi: messageTransmitterAbi } = getCctpMessageTransmitter(l2ChainId, sourceChainId);

  // Create interfaces
  const tokenMessengerInterface = new ethers.utils.Interface(tokenMessengerAbi);
  const messageTransmitterInterface = new ethers.utils.Interface(messageTransmitterAbi);

  // Validate event topic hashes to ensure interface correctness
  const depositForBurnTopic = tokenMessengerInterface.getEventTopic("DepositForBurn");
  const expectedDepositForBurnTopic = isCctpV2
    ? CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V2
    : CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V1;
  assert(
    depositForBurnTopic === expectedDepositForBurnTopic,
    `DepositForBurn topic mismatch: expected ${expectedDepositForBurnTopic}, got ${depositForBurnTopic}`
  );

  const messageSentTopic = messageTransmitterInterface.getEventTopic("MessageSent");
  assert(
    messageSentTopic === CCTP_MESSAGE_SENT_TOPIC_HASH,
    `MessageSent topic mismatch: expected ${CCTP_MESSAGE_SENT_TOPIC_HASH}, got ${messageSentTopic}`
  );

  return {
    tokenMessengerInterface,
    messageTransmitterInterface,
  };
}

/**
 * Gets all tx hashes that may be relevant for CCTP finalization.
 * This includes:
 *  - All tx hashes where `DepositForBurn` events happened (for USDC transfers).
 *  - If `isSourceHubChain` is true, all txs where HubPool on `sourceChainId` emitted `MessageRelayed` or `TokensRelayed` events.
 *
 * @param srcProvider - Provider for the source chain.
 * @param sourceChainId - Chain ID where the messages/deposits originated.
 * @param destinationChainId - Chain ID where the messages/deposits are targeted.
 * @param l2ChainId - Chain ID of the L2 chain involved (can be same as `sourceChainId`), used for CCTP versioning.
 * @param senderAddresses - Addresses that initiated the `DepositForBurn` events. If `isSourceHubChain` is true, the HubPool address itself is implicitly a sender for its messages.
 * @param sourceEventSearchConfig - Configuration for event searching on the source chain.
 * @param isSourceHubChain - If true, includes messages relayed by the HubPool. **WARNING:** If true, this function assumes a HubPool contract is configured for `sourceChainId`; otherwise, it will throw an error.
 * @returns A Set of unique transaction hashes.
 */
async function getRelevantCCTPTxHashes(
  srcProvider: Provider,
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  _senderAddresses: EvmAddress[],
  sourceEventSearchConfig: EventSearchConfig,
  isSourceHubChain: boolean
): Promise<Set<string>> {
  // At this point, all sender addresses should be EVM.
  const senderAddresses = _senderAddresses.map((address) => address.toNative());
  const txHashesFromHubPool: string[] = [];

  if (isSourceHubChain) {
    const { address: hubPoolAddress, abi } = CONTRACT_ADDRESSES[sourceChainId]?.hubPool;
    if (!isDefined(hubPoolAddress) || !isDefined(abi)) {
      throw new Error(`No HubPool address or abi found for chainId: ${sourceChainId}`);
    }

    const isHubPoolAmongSenders = senderAddresses.some((senderAddr) =>
      compareAddressesSimple(senderAddr, hubPoolAddress)
    );

    if (isHubPoolAmongSenders) {
      const hubPool = new Contract(hubPoolAddress, abi, srcProvider);

      const messageRelayedFilter = hubPool.filters.MessageRelayed();
      const tokensRelayedFilter = hubPool.filters.TokensRelayed();

      const [messageRelayedEvents, tokensRelayedEvents] = await Promise.all([
        paginatedEventQuery(hubPool, messageRelayedFilter, sourceEventSearchConfig),
        paginatedEventQuery(hubPool, tokensRelayedFilter, sourceEventSearchConfig),
      ]);

      messageRelayedEvents.forEach((e) => txHashesFromHubPool.push(e.transactionHash));
      tokensRelayedEvents.forEach((e) => txHashesFromHubPool.push(e.transactionHash));
    }
  }

  // Step 2: Get all DepositForBurn events matching the senderAddresses and source chain
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const { address, abi } = getCctpTokenMessenger(l2ChainId, sourceChainId);
  const srcTokenMessenger = new Contract(address, abi, srcProvider);

  const eventFilterParams = isCctpV2
    ? [TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId], undefined, senderAddresses]
    : [undefined, TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId], undefined, senderAddresses];
  const eventFilter = srcTokenMessenger.filters.DepositForBurn(...eventFilterParams);
  const depositForBurnEvents = (
    await paginatedEventQuery(srcTokenMessenger, eventFilter, sourceEventSearchConfig)
  ).filter((e) => e.args.destinationDomain === getCctpDomainForChainId(destinationChainId));

  const uniqueTxHashes = new Set([...txHashesFromHubPool, ...depositForBurnEvents.map((e) => e.transactionHash)]);

  return uniqueTxHashes;
}

/**
 * Gets all CCTP message events (both `DepositForBurn` for token transfers and potentially raw `MessageSent` from HubPool)
 * that can be finalized.
 *
 * It first fetches relevant transaction hashes using `getRelevantCCTPTxHashes` and then processes receipts to extract CCTP events.
 *
 * @param senderAddresses - Addresses that initiated the `DepositForBurn` events. For HubPool messages, the HubPool address is the sender.
 * @param sourceChainId - Chain ID where the messages/deposits originated.
 * @param destinationChainId - Chain ID where the messages/deposits are targeted.
 * @param l2ChainId - Chain ID of the L2 chain involved, used for CCTP versioning.
 * @param sourceEventSearchConfig - Configuration for event searching on the source chain.
 * @param isSourceHubChain - If true, includes `MessageSent` events relayed by the HubPool on `sourceChainId`.
 *                                 **WARNING:** If true, assumes HubPool exists on `sourceChainId`; otherwise, it will error.
 * @returns An array of `CCTPMessageEvent` objects.
 */
async function getCCTPMessageEvents(
  _senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig,
  isSourceHubChain: boolean
): Promise<CCTPMessageEvent[]> {
  // At this point, we are going from EVM to EVM _or_ we are going from and EVM L1 to an SVM L2. Either way, we need to ensure that all
  // `senderAddresses` are EVM.
  const senderAddresses: EvmAddress[] = _senderAddresses
    .map((address) => (address.isEVM() ? address : undefined))
    .filter(isDefined);
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const { tokenMessengerInterface, messageTransmitterInterface } = getContractInterfaces(
    l2ChainId,
    sourceChainId,
    isCctpV2
  );

  const srcProvider = getCachedProvider(sourceChainId);
  const uniqueTxHashes = await getRelevantCCTPTxHashes(
    srcProvider,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    senderAddresses,
    sourceEventSearchConfig,
    isSourceHubChain
  );

  if (uniqueTxHashes.size === 0) {
    return [];
  }

  const receipts = await Promise.all(Array.from(uniqueTxHashes).map((hash) => srcProvider.getTransactionReceipt(hash)));

  const sourceDomainId = getCctpDomainForChainId(sourceChainId);
  const destinationDomainId = getCctpDomainForChainId(destinationChainId);
  const usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId];
  assert(isDefined(usdcAddress), `USDC address not defined for chain ${sourceChainId}`);

  const relevantEvents: CCTPMessageEvent[] = [];
  for (const receipt of receipts) {
    const relevantEventsFromReceipt = getRelevantCCTPEventsFromReceipt(
      receipt,
      isCctpV2,
      tokenMessengerInterface,
      messageTransmitterInterface,
      sourceDomainId,
      destinationDomainId,
      usdcAddress,
      senderAddresses
    );
    relevantEvents.push(...relevantEventsFromReceipt);
  }

  return relevantEvents;
}

// --- Helper utilities to use in `getRelevantCCTPEventsFromReceipt` --- //
// Returns true if the log version (0=v1,1=v2) matches the version of CCTP messages we're trying to finalize
function _isMatchingCCTPVersion(logVersion: number, isCctpV2: boolean): boolean {
  return (logVersion === 0 && !isCctpV2) || (logVersion === 1 && isCctpV2);
}

// Determines whether a parsed CCTP event is relevant for the provided filtering params
function _isRelevantCCTPEvent(
  event: CCTPMessageEvent,
  sourceDomainId: number,
  destinationDomainId: number,
  senderAddresses: string[],
  usdcAddress: string
): boolean {
  const relevant =
    event.sourceDomain === sourceDomainId &&
    event.destinationDomain === destinationDomainId &&
    // This code assumes that `senderAddresses` is an array of bytes20 hex strings
    senderAddresses.some((sender) => compareAddressesSimple(sender, cctpBytes32ToAddress(event.sender)));

  if (isDepositForBurnEvent(event)) {
    // This code assumes that `usdcAddress` is a bytes20 hex string
    return relevant && compareAddressesSimple(cctpBytes32ToAddress(event.burnToken), usdcAddress);
  }
  return relevant;
}

// Decodes a `MessageSent` log into a `CommonMessageEvent`
function _createMessageSentEvent(
  log: ethers.providers.Log,
  isCctpV2: boolean,
  messageTransmitterInterface: ethers.utils.Interface
): CommonMessageEvent {
  const eventData = isCctpV2 ? _decodeCommonMessageDataV2(log) : _decodeCommonMessageDataV1(log);
  const eventFragment = messageTransmitterInterface.getEvent(CCTP_MESSAGE_SENT_TOPIC_HASH);
  const args = messageTransmitterInterface.decodeEventLog(eventFragment, log.data, log.topics);
  return {
    ...eventData,
    log: {
      ...log,
      event: eventFragment.name,
      args: spreadEvent(args),
    },
  };
}

// Decodes a `[MessageSent + DepositForBurn]` pair into a `DepositForBurnMessageEvent`
function _createDepositForBurnMessageEvent(
  messageSentLog: ethers.providers.Log,
  depositForBurnLog: ethers.providers.Log,
  isCctpV2: boolean,
  tokenMessengerInterface: ethers.utils.Interface
): DepositForBurnMessageEvent {
  const eventData = isCctpV2
    ? _decodeDepositForBurnMessageDataV2(messageSentLog)
    : _decodeDepositForBurnMessageDataV1(messageSentLog);

  const logDescription = tokenMessengerInterface.parseLog(depositForBurnLog);
  const spreadArgs = spreadEvent(logDescription.args);

  // Ensure data integrity between MessageSent and DepositForBurn events
  if (
    !compareAddressesSimple(eventData.sender, cctpAddressToBytes32(spreadArgs.depositor)) ||
    !compareAddressesSimple(eventData.recipient, cctpAddressToBytes32(spreadArgs.mintRecipient)) ||
    !BigNumber.from(eventData.amount).eq(spreadArgs.amount)
  ) {
    const { transactionHash: txnHash, logIndex } = depositForBurnLog;
    throw new Error(
      `Decoded message at log index ${messageSentLog.logIndex} does not match the DepositForBurn event in ${txnHash} at log index ${logIndex}`
    );
  }

  return {
    ...eventData,
    log: {
      ...depositForBurnLog,
      event: logDescription.name,
      args: spreadArgs,
    },
  };
}
// --- END OF helpers for `getRelevantCCTPEventsFromReceipt` --- //

function getRelevantCCTPEventsFromReceipt(
  receipt: ethers.providers.TransactionReceipt,
  isCctpV2: boolean,
  tokenMessengerInterface: ethers.utils.Interface,
  messageTransmitterInterface: ethers.utils.Interface,
  sourceDomainId: number,
  destinationDomainId: number,
  usdcAddress: string,
  _senderAddresses: EvmAddress[]
): CCTPMessageEvent[] {
  const senderAddresses = _senderAddresses.map((address) => address.toNative());
  const relevantEvents: CCTPMessageEvent[] = [];

  /*
  For this receipt, go through all logs one-by-one.
  Identify:
    1. CCTP token transfers => these show up in the logs as pairs: [MessageSent + DepositForBurn] events
    2. CCTP tokenless messages => these show up as standalone `MessageSent` events (either not 
    followed by any other cctp event we're tracking, or followed by another MessageSent event in 
    the logs array, not necessarily consecutively)
  */

  // Indices of individual `MessageSent` events in `receipt.logs`
  const messageSentIndices = [];
  // Pairs of indices representing a single CCTP token transfer
  const depositIndexPairs = [];
  receipt.logs.forEach((log, i) => {
    // Attempt to parse as `MessageSent`
    const messageSentVersion = _getMessageSentVersion(log);
    const isMessageSentEvent = messageSentVersion !== -1;

    if (isMessageSentEvent) {
      if (_isMatchingCCTPVersion(messageSentVersion, isCctpV2)) {
        // Record a `MessageSent` event into the `messageSentIndices` array
        messageSentIndices.push(i);
      }
      return; // Continue to next log
    }

    // Attempt to parse as `DepositForBurn`
    const depositForBurnVersion = _getDepositForBurnVersion(log);
    const isDepositForBurnEvent = depositForBurnVersion !== -1;

    if (!isDepositForBurnEvent) {
      return; // Neither MessageSent nor DepositForBurn
    }

    if (_isMatchingCCTPVersion(depositForBurnVersion, isCctpV2)) {
      if (messageSentIndices.length === 0) {
        throw new Error(
          "DepositForBurn event found without corresponding MessageSent event. Each DepositForBurn event must have a preceding MessageSent event in the same transaction. " +
            `Transaction: ${receipt.transactionHash}, DepositForBurn log index: ${i}`
        );
      }

      // Record a `MessageSent` + `DepositForBurn` pair into the `depositIndexPairs` array
      const correspondingMessageSentIndex = messageSentIndices.pop();
      depositIndexPairs.push([correspondingMessageSentIndex, i]);
    }
  });

  // Process all the individual tokenless CCTP messages
  for (const messageSentIndex of messageSentIndices) {
    const event = _createMessageSentEvent(receipt.logs[messageSentIndex], isCctpV2, messageTransmitterInterface);
    if (_isRelevantCCTPEvent(event, sourceDomainId, destinationDomainId, senderAddresses, usdcAddress)) {
      relevantEvents.push(event);
    }
  }

  // Process all the CCTP token transfers (each composed of 2 events)
  for (const [messageSentIndex, depositForBurnIndex] of depositIndexPairs) {
    const event = _createDepositForBurnMessageEvent(
      receipt.logs[messageSentIndex],
      receipt.logs[depositForBurnIndex],
      isCctpV2,
      tokenMessengerInterface
    );
    if (_isRelevantCCTPEvent(event, sourceDomainId, destinationDomainId, senderAddresses, usdcAddress)) {
      relevantEvents.push(event);
    }
  }

  return relevantEvents;
}

async function getCCTPMessagesWithStatus(
  senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig,
  isSourceHubChain: boolean,
  signer?: KeyPairSigner
): Promise<AttestedCCTPMessage[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const cctpMessageEvents = await getCCTPMessageEvents(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    sourceEventSearchConfig,
    isSourceHubChain
  );
  const dstProvider = getCachedProvider(destinationChainId);
  const { address, abi } = getCctpMessageTransmitter(l2ChainId, destinationChainId);
  const messageTransmitterContract = chainIsSvm(destinationChainId)
    ? undefined
    : new Contract(address, abi, dstProvider);
  return await Promise.all(
    cctpMessageEvents.map(async (messageEvent) => {
      // @dev Currently we have no way to recreate the V2 nonce hash until after we've received the attestation,
      // so skip this step for V2 since we have no way of knowing whether the message is finalized until after we
      // query the Attestation API service.
      if (isCctpV2) {
        return {
          ...messageEvent,
          status: "pending",
        };
      }
      let processed;
      if (chainIsSvm(destinationChainId)) {
        assert(signer, "Signer is required for Solana CCTP messages");
        processed = await arch.svm.hasCCTPV1MessageBeenProcessed(
          getSvmProvider(await getRedisCache()),
          signer,
          messageEvent.nonce,
          messageEvent.sourceDomain
        );
      } else {
        processed = await _hasCCTPMessageBeenProcessedEvm(messageEvent.nonceHash, messageTransmitterContract);
      }

      if (!processed) {
        return {
          ...messageEvent,
          status: "pending", // We'll flip to ready once we get the attestation.
        };
      } else {
        return {
          ...messageEvent,
          status: "finalized",
        };
      }
    })
  );
}

// same as `getAttestedCCTPMessages`, but filters out all non-deposit CCTP messages
/**
 * Fetches attested CCTP messages using `getAttestedCCTPMessages` (with HubPool messages explicitly excluded)
 * and then filters them to return only `DepositForBurn` events (i.e., token deposits).
 *
 * This function is specifically for retrieving CCTP deposits and always calls the underlying
 * `getAttestedCCTPMessages` with the `isSourceHubChain` flag set to `false`,
 * ensuring that only potential `DepositForBurn` related transactions are initially considered.
 *
 * @param senderAddresses - List of sender addresses to filter the `DepositForBurn` query.
 * @param sourceChainId - Chain ID where the Deposit was created.
 * @param destinationChainId - Chain ID where the Deposit is being sent to.
 * @param l2ChainId - Chain ID of the L2 chain involved in the CCTP deposit. This is used to identify whether the CCTP deposit is V1 or V2.
 * @param sourceEventSearchConfig - Configuration for event searching.
 * @returns A promise that resolves to an array of `AttestedCCTPDeposit` objects.
 */
export async function getAttestedCCTPDeposits(
  senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<AttestedCCTPDeposit[]> {
  const messages = await getAttestedCCTPMessages(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    sourceEventSearchConfig
  );
  // only return deposit messages
  return messages.filter((message) => isDepositForBurnEvent(message)) as AttestedCCTPDeposit[];
}

/**
 * @notice Returns all non-finalized CCTP messages (both `DepositForBurn` and potentially raw `MessageSent` from HubPool)
 * with their attestations attached. Attestations will be undefined if the attestation "status" is not "ready".
 *
 * If `isSourceHubChain` is true, this function will also look for `MessageSent` events that were initiated by the `HubPool`
 * contract on the `sourceChainId` and are directed towards a `SpokePool` on the `destinationChainId`. These are considered "raw"
 * CCTP messages with custom payloads, distinct from the standard `DepositForBurn` token transfers.
 *
 * **WARNING:** If `isSourceHubChain` is set to `true`, this function critically assumes that a `HubPool` contract address
 * is configured and available on the `sourceChainId`. If `sourceChainId` is an L2 (or any chain without a configured HubPool)
 * and this flag is `true`, the function will throw an error during the attempt to fetch HubPool-related events.
 *
 * @param senderAddresses - List of sender addresses to filter `DepositForBurn` events. For `MessageSent` events from HubPool,
 *                        the HubPool address itself acts as the sender and is used implicitly if `isSourceHubChain` is true.
 * @param sourceChainId - Chain ID where the CCTP messages originated (e.g., an L2 for deposits, or L1 for HubPool messages).
 * @param destinationChainId - Chain ID where the CCTP messages are being sent to.
 * @param l2ChainId - Chain ID of the L2 chain involved in the CCTP interaction. This is used to determine CCTP versioning (V1 vs V2)
 *                  for contract ABIs and event decoding logic, especially when `sourceChainId` itself might be an L1.
 * @param sourceEventSearchConfig - Configuration for event searching on the `sourceChainId`.
 * @returns A promise that resolves to an array of `AttestedCCTPMessage` objects. These can be `AttestedCCTPDeposit` or common `AttestedCCTPMessage` types.
 */
export async function getAttestedCCTPMessages(
  senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig,
  signer?: KeyPairSigner
): Promise<AttestedCCTPMessage[]> {
  const isCctpV2 = isCctpV2L2ChainId(l2ChainId);
  const isMainnet = utils.chainIsProd(destinationChainId);
  const isSourceHubChain = [CHAIN_IDs.MAINNET, CHAIN_IDs.SEPOLIA].includes(sourceChainId);
  // Reading Solana deposits/attestations follows a different flow from EVM networks, so divert to this flow if the source chain is Solana.
  if (chainIsSvm(sourceChainId)) {
    assert(!isSourceHubChain);
    return _getCCTPDepositEventsSvm(
      senderAddresses,
      sourceChainId,
      destinationChainId,
      l2ChainId,
      sourceEventSearchConfig
    );
  }
  const messagesWithStatus = await getCCTPMessagesWithStatus(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    l2ChainId,
    sourceEventSearchConfig,
    isSourceHubChain,
    signer
  );

  // Temporary structs we'll need until we can derive V2 nonce hashes:
  let destinationMessageTransmitter: ethers.Contract;
  const attestationResponses: Map<string, CCTPV2APIGetAttestationResponse> = new Map();

  if (isCctpV2) {
    // For v2, we're using an EVM `destinationMessageTransmitter` to determine message status, so destinationChain must be EVM
    assert(!chainIsSvm(destinationChainId));

    const dstProvider = getCachedProvider(destinationChainId);
    const { address, abi } = getCctpMessageTransmitter(l2ChainId, destinationChainId);
    destinationMessageTransmitter = new ethers.Contract(address, abi, dstProvider);

    // For v2, we fetch an API response for every txn hash we have. API returns an array of both v1 and v2 attestations
    const sourceDomainId = getCctpDomainForChainId(sourceChainId);
    const uniqueTxHashes = Array.from(new Set([...messagesWithStatus.map((message) => message.log.transactionHash)]));

    // Circle rate limit is 35 requests / second. To avoid getting banned, batch calls into chunks with 1 second delay between chunks
    // For v2, this is actually required because we don't know if message is finalized or not before hitting the API. Therefore as our
    // CCTP v2 list of chains grows, we might require more than 35 calls here to fetch all attestations
    const chunkSize = 8;
    for (let i = 0; i < uniqueTxHashes.length; i += chunkSize) {
      const chunk = uniqueTxHashes.slice(i, i + chunkSize);

      await Promise.all(
        chunk.map(async (txHash) => {
          const attestations = await _fetchAttestationsForTxn(sourceDomainId, txHash, isMainnet);
          attestationResponses.set(txHash, attestations);
        })
      );

      if (i + chunkSize < uniqueTxHashes.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  const attestedMessages = await Promise.all(
    messagesWithStatus.map(async (message) => {
      // If deposit is already finalized, we won't change its attestation status:
      if (message.status === "finalized") {
        return message;
      }

      // Otherwise, update the deposit's status after loading its attestation.
      if (isCctpV2) {
        const attestations = attestationResponses.get(message.log.transactionHash);

        const matchingAttestation = attestations.messages.find((apiAttestation) => {
          return cmpAPIToEventMessageBytesV2(apiAttestation.message, message.messageBytes);
        });

        if (!matchingAttestation) {
          const anyApiMessageIsPending = attestations.messages.some(
            (attestation) => _getPendingAttestationStatus(attestation) === "pending"
          );

          if (anyApiMessageIsPending) {
            // If any API message for this transaction is pending, we treat our current message as pending too.
            return {
              ...message,
              status: "pending" as CCTPMessageStatus,
              attestation: undefined,
            };
          } else {
            // No matching attestation found, and no other API messages for this transaction are pending.
            throw new Error(
              `No matching CCTP V2 attestation found in CCTP API response for message in tx ${message.log.transactionHash}, sourceDomain ${message.sourceDomain}, logIndex ${message.log.logIndex}. Additionally, no other messages from the API for this transaction are in a 'pending' state.`
            );
          }
        }

        const processed = await _hasCCTPMessageBeenProcessedEvm(
          matchingAttestation.eventNonce,
          destinationMessageTransmitter
        );
        if (processed) {
          return {
            ...message,
            status: "finalized" as CCTPMessageStatus,
          };
        } else {
          return {
            ...message,
            // For CCTPV2, the message is different than the one emitted in the Deposit because it includes the nonce, and
            // we need the messageBytes to submit the receiveMessage call successfully. We don't overwrite the messageHash
            // because its not needed for V2
            nonceHash: matchingAttestation.eventNonce,
            messageBytes: matchingAttestation.message,
            attestation: matchingAttestation?.attestation, // Will be undefined if status is "pending"
            status: _getPendingAttestationStatus(matchingAttestation),
          };
        }
      } else {
        // For v1 messages, fetch attestation by messageHash -> receive a single attestation in response
        const attestation = await _fetchAttestation(message.messageHash, isMainnet);
        return {
          ...message,
          attestation: attestation?.attestation, // Will be undefined if status is "pending"
          status: _getPendingAttestationStatus(attestation),
        };
      }
    })
  );
  return attestedMessages;
}

function _getPendingAttestationStatus(
  attestation: CCTPV2APIAttestation | CCTPAPIGetAttestationResponse
): CCTPMessageStatus {
  if (!isDefined(attestation.attestation)) {
    return "pending";
  } else {
    return attestation.status === "pending_confirmations" || attestation.attestation === "PENDING"
      ? "pending"
      : "ready";
  }
}

async function _hasCCTPMessageBeenProcessedEvm(nonceHash: string, contract: ethers.Contract): Promise<boolean> {
  const resultingCall: BigNumber = await contract.callStatic.usedNonces(nonceHash);
  // If the resulting call is 1, the message has been processed. If it is 0, the message has not been processed.
  return (resultingCall ?? bnZero).toNumber() === 1;
}

async function _getCCTPDepositEventsSvm(
  senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  l2ChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<AttestedCCTPDeposit[]> {
  // Get the `DepositForBurn` events on Solana.
  const provider = getSvmProvider(await getRedisCache());
  const { address } = getCctpTokenMessenger(l2ChainId, sourceChainId);

  const eventClient = await SvmCpiEventsClient.createFor(provider, address, TokenMessengerMinterIdl);
  const depositForBurnEvents = await eventClient.queryDerivedAddressEvents(
    "DepositForBurn",
    arch.svm.toAddress(SvmAddress.from(address)),
    BigInt(sourceEventSearchConfig.from),
    BigInt(sourceEventSearchConfig.to)
  );

  const dstProvider = getCachedProvider(destinationChainId);
  const { address: dstMessageTransmitterAddress, abi } = getCctpMessageTransmitter(l2ChainId, destinationChainId);
  const destinationMessageTransmitter = new ethers.Contract(dstMessageTransmitterAddress, abi, dstProvider);

  // Query the CCTP API to get the encoded message bytes/attestation.
  // Return undefined if we need to filter out the deposit event.
  const _depositsWithAttestations = await mapAsync(depositForBurnEvents, async (event) => {
    const eventData = event.data as MinimalSvmDepositForBurnData;
    const depositor = SvmAddress.from(eventData.depositor);
    const destinationDomain = eventData.destinationDomain;

    if (
      !senderAddresses.some((addr) => addr.eq(depositor)) ||
      getCctpDomainForChainId(destinationChainId) !== destinationDomain
    ) {
      return undefined;
    }

    const attestation = await _fetchCCTPSvmAttestationProof(event.signature);
    return await mapAsync(attestation.messages, async (data) => {
      const decodedMessage = _decodeDepositForBurnMessageDataV1({ data: data.message }, true);
      if (
        !senderAddresses.some((addr) => compareAddressesSimple(addr.toBytes32(), decodedMessage.sender)) ||
        getCctpDomainForChainId(destinationChainId) !== decodedMessage.destinationDomain
      ) {
        return undefined;
      }
      // The destination network cannot be Solana since the origin network is Solana.
      const attestationStatusObject = await _fetchAttestation(decodedMessage.messageHash, chainIsProd(l2ChainId));
      const alreadyProcessed = await _hasCCTPMessageBeenProcessedEvm(
        decodedMessage.nonceHash,
        destinationMessageTransmitter
      );
      return {
        ...decodedMessage,
        attestation: data.attestation,
        status: alreadyProcessed
          ? ("finalized" as CCTPMessageStatus)
          : _getPendingAttestationStatus(attestationStatusObject),
        log: undefined,
      };
    });
  });
  return _depositsWithAttestations.flat().filter(isDefined);
}

function _decodeCommonMessageDataV1(message: { data: string }, isSvm = false): CommonMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const messageBytes = isSvm ? message.data : ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // sourceDomain 4 bytes starting index 4
  const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // destinationDomain 4 bytes starting index 8
  const nonce = BigNumber.from(ethers.utils.hexlify(messageBytesArray.slice(12, 20))).toNumber(); // nonce 8 bytes starting index 12
  const sender = ethers.utils.hexlify(messageBytesArray.slice(20, 52)); // sender	20	bytes32	32	Address of MessageTransmitter caller on source domain
  const recipient = ethers.utils.hexlify(messageBytesArray.slice(52, 84)); // recipient	52	bytes32	32	Address to handle message body on destination domain

  // V1 nonce hash is a simple hash of the nonce emitted in Deposit event with the source domain ID.
  const nonceHash = ethers.utils.keccak256(ethers.utils.solidityPack(["uint32", "uint64"], [sourceDomain, nonce]));

  return {
    cctpVersion: 1,
    sourceDomain,
    destinationDomain,
    sender,
    recipient,
    nonce,
    nonceHash,
    messageHash: ethers.utils.keccak256(messageBytes),
    messageBytes,
  };
}

function _decodeCommonMessageDataV2(message: { data: string }, isSvm = false): CommonMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const messageBytes = isSvm ? message.data : ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // sourceDomain 4 bytes starting index 4
  const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // destinationDomain 4 bytes starting index 8
  const sender = ethers.utils.hexlify(messageBytesArray.slice(44, 76)); // sender	44	bytes32	32	Address of MessageTransmitterV2 caller on source domain
  const recipient = ethers.utils.hexlify(messageBytesArray.slice(76, 108)); // recipient	76	bytes32	32	Address to handle message body on destination domain

  return {
    cctpVersion: 2,
    sourceDomain,
    destinationDomain,
    sender,
    recipient,
    // For v2, we rely on Circle's API to find nonceHash. `nonce` is undefined
    nonce: undefined,
    nonceHash: ethers.constants.HashZero,
    messageHash: ethers.utils.keccak256(messageBytes),
    messageBytes,
  };
}

function _decodeDepositForBurnMessageDataV1(message: { data: string }, isSvm = false): DepositForBurnMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const commonDataV1 = _decodeCommonMessageDataV1(message, isSvm);
  const messageBytes = isSvm ? message.data : ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  // Values specific to `DepositForBurn`. These are values contained within `messageBody` bytes (the last of the message.data fields)
  const burnToken = ethers.utils.hexlify(messageBytesArray.slice(120, 152)); // burnToken 4 bytes32 32 Address of burned token on source domain
  const mintRecipient = ethers.utils.hexlify(messageBytesArray.slice(152, 184)); // mintRecipient 32 bytes starting index 152 (idx 36 of body after idx 116 which ends the header)
  const amount = ethers.utils.hexlify(messageBytesArray.slice(184, 216)); // amount 32 bytes starting index 184 (idx 68 of body after idx 116 which ends the header)
  const sender = ethers.utils.hexlify(messageBytesArray.slice(216, 248)); // sender 32 bytes starting index 216 (idx 100 of body after idx 116 which ends the header)

  return {
    ...commonDataV1,
    burnToken,
    amount: BigNumber.from(amount).toString(),
    // override sender and recipient from `DepositForBurn`-specific values. This is required because raw sender / recipient for a message like this
    // are CCTP's TokenMessenger contracts rather than the addrs sending / receiving tokens
    sender: sender,
    recipient: mintRecipient,
    mintRecipient,
  };
}

function _decodeDepositForBurnMessageDataV2(message: { data: string }, isSvm = false): DepositForBurnMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const commonData = _decodeCommonMessageDataV2(message, isSvm);
  const messageBytes = isSvm ? message.data : ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  const burnToken = ethers.utils.hexlify(messageBytesArray.slice(152, 184)); // burnToken: Address of burned token on source domain. 32 bytes starting index 152 (idx 4 of body after idx 148 which ends the header)
  const mintRecipient = ethers.utils.hexlify(messageBytesArray.slice(184, 216)); // recipient 32 bytes starting index 184 (idx 36 of body after idx 148 which ends the header)
  const amount = ethers.utils.hexlify(messageBytesArray.slice(216, 248)); // amount 32 bytes starting index 216 (idx 68 of body after idx 148 which ends the header)
  const sender = ethers.utils.hexlify(messageBytesArray.slice(248, 280)); // sender 32 bytes starting index 248 (idx 100 of body after idx 148 which ends the header)

  return {
    ...commonData,
    burnToken,
    amount: BigNumber.from(amount).toString(),
    // override sender and recipient from `DepositForBurn`-specific values. This is required because raw sender / recipient for a message like this
    // are CCTP's TokenMessenger contracts rather than the addrs sending / receiving tokens
    sender: sender,
    recipient: mintRecipient,
    mintRecipient,
  };
}

/**
 * Generates an attestation proof for a given message hash. This is required to finalize a CCTP message.
 * @dev Only works for v1 messages because we don't have nonceHash filled in for message when the v2 event is emitted on-chain, so we can't generate a messageHash locally.
 * That's why for v2 messages we have to use _fetchAttestationsForTxn instead
 * @param messageHash The message hash to generate an attestation proof for. This is generated by taking the keccak256 hash of the message bytes of the initial transaction log.
 * @param isMainnet Whether or not the attestation proof should be generated on mainnet. If this is false, the attestation proof will be generated on the sandbox environment.
 * @returns The attestation status and proof for the given message hash. This is a string of the form "0x<attestation proof>". If the status is pending_confirmation
 * then the proof will be null according to the CCTP dev docs.
 * @link https://developers.circle.com/stablecoins/reference/getattestation
 */
async function _fetchAttestation(messageHash: string, isMainnet: boolean): Promise<CCTPAPIGetAttestationResponse> {
  const httpResponse = await axios.get<CCTPAPIGetAttestationResponse>(
    `https://iris-api${isMainnet ? "" : "-sandbox"}.circle.com/attestations/${messageHash}`
  );
  const attestationResponse = httpResponse.data;
  return attestationResponse;
}

// @todo: We can pass in a nonceHash here once we know how to recreate the nonceHash.
// Returns both v1 and v2 attestations
async function _fetchAttestationsForTxn(
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

async function _fetchCCTPSvmAttestationProof(transactionHash: string): Promise<CCTPSvmAPIGetAttestationResponse> {
  const httpResponse = await axios.get<CCTPSvmAPIGetAttestationResponse>(
    `https://iris-api.circle.com/messages/5/${transactionHash}`
  );
  const attestationResponse = httpResponse.data;
  return attestationResponse;
}

// This function compares message we need to finalize with the api response message. It skips the `nonce` part of comparison as it's not set at the time of emitting an on-chain `MessageSent` event
// It also skips finalityThresholdExecuted comparison for the same reason. See https://github.com/circlefin/evm-cctp-contracts/blob/6e7513cdb2bee6bb0cddf331fe972600fc5017c9/src/messages/v2/MessageV2.sol#L89
function cmpAPIToEventMessageBytesV2(apiResponseMessage: string, eventMessageBytes: string): boolean {
  // Source https://developers.circle.com/stablecoins/message-format
  const normalize = (hex: string) => (hex.startsWith("0x") ? hex.substring(2) : hex).toLowerCase();
  const normApiMsg = normalize(apiResponseMessage);
  const normLocalMsg = normalize(eventMessageBytes);

  if (normApiMsg.length !== normLocalMsg.length) {
    return false;
  }

  // Segment 1: Bytes [0 .. 12)
  const seg1Api = normApiMsg.substring(0, 24);
  const seg1Local = normLocalMsg.substring(0, 24);
  if (seg1Api !== seg1Local) {
    return false;
  }

  // Skip `nonce`: Bytes [12 .. 44)

  // Segment 2: Bytes [44 .. 143)
  const seg2Api = normApiMsg.substring(88, 288);
  const seg2Local = normLocalMsg.substring(88, 288);
  if (seg2Api !== seg2Local) {
    return false;
  }

  // Skip `finalityThresholdExecuted`: Bytes [144 .. 148)

  // Segment 3: Bytes [148..end)
  const seg3Api = normApiMsg.substring(296);
  const seg3Local = normLocalMsg.substring(296);
  if (seg3Api !== seg3Local) {
    return false;
  }

  return true;
}

// returns 0 for v1 `MessageSent` event, 1 for v2, -1 for other events
const _getMessageSentVersion = (log: ethers.providers.Log): number => {
  if (log.topics[0] !== CCTP_MESSAGE_SENT_TOPIC_HASH) {
    return -1;
  }
  // v1 and v2 have the same topic hash, so we have to do a bit of decoding here to understand the version
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], log.data)[0];
  // Source: https://developers.circle.com/stablecoins/message-format
  const version = parseInt(messageBytes.slice(2, 10), 16); // read version: first 4 bytes (skipping '0x')
  return version;
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
