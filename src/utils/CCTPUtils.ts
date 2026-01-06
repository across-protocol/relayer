import { arch, utils } from "@across-protocol/sdk";
import { TokenMessengerMinterIdl } from "@across-protocol/contracts";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import axios from "axios";
import { Contract, ethers } from "ethers";
import { CONTRACT_ADDRESSES, CCTP_MAX_SEND_AMOUNT } from "../common";
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
  getTokenInfo,
  toBNWei,
  forEachAsync,
  chainIsEvm,
  createFormatFunction,
} from "./SDKUtils";
import { getNetworkName } from "./NetworkUtils";
import { isDefined } from "./TypeGuards";
import { getCachedProvider, getProvider, getSvmProvider } from "./ProviderUtils";
import { EventSearchConfig, paginatedEventQuery, spreadEvent } from "./EventUtils";
import { Log } from "../interfaces";
import { assert, getRedisCache, Provider, Signer, ERC20, winston } from ".";
import { KeyPairSigner } from "@solana/kit";
import { TransactionRequest } from "@ethersproject/abstract-provider";
import {
  aboveAllowanceThreshold,
  getL2TokenAllowanceFromCache,
  setL2TokenAllowanceInCache,
  TransferTokenParams,
  approveTokens as approveBridgeTokens,
} from "../adapter/utils";

/** ********************************************************************************************************************
 *
 * CCTP API TYPES
 *
 ******************************************************************************************************************* **/

// CCTP V1 /messages/{sourceDomainId}/{transactionHash} response
type CCTPV1APIMessageAttestation = {
  attestation: string;
  message: string;
  eventNonce: string;
};
type CCTPV1APIGetMessagesResponse = { messages: CCTPV1APIMessageAttestation[] };

// CCTP V1 /attestations/{messageHash} response
type CCTPV1APIGetAttestationResponse = { status: string; attestation: string };

/** ********************************************************************************************************************
 *
 * CCTP SMART CONTRACT EVENT TYPES
 *
 ******************************************************************************************************************* **/

// Params shared by Message and DepositForBurn events.
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
type DepositForBurnMessageData = CommonMessageData & { amount: string; mintRecipient: string; burnToken: string };
type CommonMessageEvent = CommonMessageData & { log: Log };
type DepositForBurnMessageEvent = DepositForBurnMessageData & { log: Log };
type CCTPMessageEvent = CommonMessageEvent | DepositForBurnMessageEvent;

// CCTP V2 hookData structure for sponsored deposits
export type CCTPHookData = {
  nonce: string; // bytes32
  deadline: string; // uint256 as string
  maxBpsToSponsor: number;
  maxUserSlippageBps: number;
  finalRecipient: string; // address (extracted from bytes32)
  finalToken: string; // address (extracted from bytes32)
  executionMode: number; // uint8
  actionData: string; // bytes
};

const CCTP_MESSAGE_SENT_TOPIC_HASH = ethers.utils.id("MessageSent(bytes)");

/** ********************************************************************************************************************
 *
 * Exported functions and constants:
 *
 ******************************************************************************************************************* **/

export const { CCTPV2_FINALITY_THRESHOLD_FAST, CCTPV2_FINALITY_THRESHOLD_STANDARD } = utils;
export type AttestedCCTPMessage = utils.AttestedCCTPMessage;
export type AttestedCCTPDeposit = utils.AttestedCCTPDeposit;

export const {
  cctpAddressToBytes32,
  cctpBytes32ToAddress,
  getCctpDomainForChainId,
  getCctpDestinationChainFromDomain,
  isDepositForBurnEvent,
} = utils;

// Import types and utilities needed for the constructCctpDepositForBurnTxn function
import type { AugmentedTransaction } from "../clients/TransactionClient";

/**
 * Return all deposit for burn transaction hashes that were created on the source chain.
 * @param srcProvider Provider for the source chain.
 * @param sourceChainId Chain ID where the deposit for burn events originated.
 * @param _senderAddresses Addresses that initiated the `DepositForBurn` events.
 * @param sourceEventSearchConfig Event search filter on origin chain.
 * @returns A list of transaction hashes.
 */
export async function getCctpV2DepositForBurnTxnHashes(
  srcProvider: Provider,
  sourceChainId: number,
  _senderAddresses: Address[],
  sourceEventSearchConfig: EventSearchConfig
): Promise<string[]> {
  const senderAddresses = _senderAddresses.map((address) => address.toNative());
  const { address, abi } = getCctpV2TokenMessenger(sourceChainId);
  const srcTokenMessenger = new Contract(address, abi, srcProvider);

  const eventFilterParams = [TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId], undefined, senderAddresses];
  const eventFilter = srcTokenMessenger.filters.DepositForBurn(...eventFilterParams);
  const depositForBurnEvents = await paginatedEventQuery(srcTokenMessenger, eventFilter, sourceEventSearchConfig);
  return depositForBurnEvents.map((e) => e.transactionHash);
}

/**
 * @notice Returns the statuses of all CCTP V2 deposit for burn events on the source chain.
 * @param depositForBurnHashes Transaction hashes of CCTP V2 deposit for burn events.
 * @param sourceChainId Chain ID where the deposit for burn events originated.
 * @param senderAndRecipientAddresses Addresses that initiated the `DepositForBurn` events.
 * @returns A list of deposit transaction hashes with different finalization statuses.
 * Returns:
 * - pendingDepositTxnHashes: Transaction hashes of deposits that are pending attestation.
 * - finalizedDepositTxnHashes: Transaction hashes of deposits that have been finalized.
 * - readyToFinalizeDeposits: Transaction hashes of deposits that are ready to be finalized.
 */
export async function getCctpV2DepositForBurnStatuses(
  depositForBurnHashes: string[],
  sourceChainId: number,
  senderAndRecipientAddresses: Address[]
): Promise<{
  pendingDepositTxnHashes: string[];
  finalizedDepositTxnHashes: { txnHash: string; destinationChainId: number }[];
  readyToFinalizeDeposits: {
    txnHash: string;
    destinationChainId: number;
    attestationData: { attestation: string; message: string; amount: string };
  }[];
}> {
  // Fetch attestations for all deposit burn event transaction hashes. Note, some events might share the same
  // transaction hash, so only fetch attestations for unique transaction hashes.
  const uniqueTxHashes = Array.from(new Set(depositForBurnHashes));
  const attestationResponses = await utils.fetchCctpV2Attestations(uniqueTxHashes, sourceChainId);

  // Categorize deposits based on status:
  const pendingDepositTxnHashes: string[] = [];
  const finalizedDepositTxnHashes: { txnHash: string; destinationChainId: number }[] = [];
  const readyToFinalizeDeposits: {
    txnHash: string;
    destinationChainId: number;
    attestationData: { attestation: string; message: string; amount: string };
  }[] = [];
  await forEachAsync(Object.entries(attestationResponses), async ([txnHash, attestations]) => {
    await forEachAsync(attestations.messages, async (attestation) => {
      if (attestation.cctpVersion !== 2) {
        return;
      }
      // API has not produced an attestation for this deposit yet:
      if (utils.getPendingAttestationStatus(attestation) === "pending") {
        pendingDepositTxnHashes.push(txnHash);
        return;
      }

      // Filter out events where the sender or recipient is not one of our expected addresses.
      const recipient = attestation.decodedMessage.decodedMessageBody.mintRecipient;
      const sender = attestation.decodedMessage.decodedMessageBody.messageSender;
      if (
        !senderAndRecipientAddresses.some(
          (address) => address.eq(EvmAddress.from(recipient)) || address.eq(EvmAddress.from(sender))
        )
      ) {
        return;
      }

      // If API attestationstatus is "complete", then we need to check whether it has been already finalized:
      const destinationChainId = getCctpDestinationChainFromDomain(
        attestation.decodedMessage.destinationDomain,
        chainIsProd(sourceChainId)
      );
      const destinationMessageTransmitter = await _getDestinationMessageTransmitterContract(destinationChainId, false);
      const processed = await utils.hasCCTPMessageBeenProcessedEvm(
        attestation.eventNonce,
        destinationMessageTransmitter
      );
      if (processed) {
        finalizedDepositTxnHashes.push({ txnHash, destinationChainId });
      } else {
        readyToFinalizeDeposits.push({
          txnHash,
          destinationChainId,
          attestationData: {
            attestation: attestation.attestation,
            message: attestation.message,
            amount: attestation.decodedMessage.decodedMessageBody.amount,
          },
        });
      }
    });
  });
  return { pendingDepositTxnHashes, finalizedDepositTxnHashes, readyToFinalizeDeposits };
}

/**
 * Returns the calldata and target contract required to finalize a CCTP deposit for burn event. Works for both
 * V1 and V2 CCTP events.
 * @param readyToFinalizeDeposit Contains attestation along with destination chain where to send finalization txn to.
 * @param cctpV1 Instructs function about which destination message transmitter contract to call.
 * @returns Calldata and target contract required to finalize a CCTP deposit for burn event.
 */
export async function getCctpReceiveMessageCallData(
  readyToFinalizeDeposit: {
    destinationChainId: number;
    attestationData: { attestation: string; message: string };
  },
  cctpV1: boolean
): Promise<TransactionRequest> {
  const messageTransmitter = await _getDestinationMessageTransmitterContract(
    readyToFinalizeDeposit.destinationChainId,
    cctpV1
  );
  return (await messageTransmitter.populateTransaction.receiveMessage(
    readyToFinalizeDeposit.attestationData.message,
    readyToFinalizeDeposit.attestationData.attestation
  )) as TransactionRequest;
}

/**
 * @notice Fetches attested CCTP messages using `getCctpV1Messages` and then filters them to
 * return only `DepositForBurn` events (i.e., token deposits).
 * @param senderAddresses - List of sender addresses to filter the `DepositForBurn` query.
 * @param sourceChainId - Chain ID where the Deposit was created.
 * @param destinationChainId - Chain ID where the Deposit is being sent to.
 * @param sourceEventSearchConfig - Configuration for event searching.
 * @returns A promise that resolves to an array of `AttestedCCTPDeposit` objects.
 */
export async function getCCTPV1Deposits(
  senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<AttestedCCTPDeposit[]> {
  const messages = await getCctpV1Messages(senderAddresses, sourceChainId, destinationChainId, sourceEventSearchConfig);
  // only return deposit messages
  return messages.filter((message) => isDepositForBurnEvent(message)) as AttestedCCTPDeposit[];
}

/**
 * @notice Returns all non-finalized CCTP V1 messages (both `DepositForBurn` and potentially raw `MessageSent` from HubPool)
 * with their attestations attached. Attestations will be undefined if the attestation "status" is not "ready".
 * @param senderAddresses - List of sender addresses to filter `DepositForBurn` events. For `MessageSent` events from HubPool,
 *                        the HubPool address itself acts as the sender and is used implicitly if `isSourceHubChain` is true.
 * @param sourceChainId - Chain ID where the CCTP messages originated (e.g., an L2 for deposits, or L1 for HubPool messages).
 * @param destinationChainId - Chain ID where the CCTP messages are being sent to.
 * @param sourceEventSearchConfig - Configuration for event searching on the `sourceChainId`.
 * @returns A promise that resolves to an array of `AttestedCCTPMessage` objects. These can be `AttestedCCTPDeposit` or common `AttestedCCTPMessage` types.
 */
export async function getCctpV1Messages(
  senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  sourceEventSearchConfig: EventSearchConfig,
  signer?: KeyPairSigner
): Promise<AttestedCCTPMessage[]> {
  const isMainnet = utils.chainIsProd(destinationChainId);
  // Reading Solana deposits/attestations follows a different flow from EVM networks, so divert to this flow if the source chain is Solana.
  if (chainIsSvm(sourceChainId)) {
    return _getCCTPV1DepositEventsSvm(senderAddresses, sourceChainId, destinationChainId, sourceEventSearchConfig);
  }
  const messagesWithStatus = await _getCCTPV1MessagesWithStatus(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    sourceEventSearchConfig,
    signer
  );

  const attestedMessages = await Promise.all(
    messagesWithStatus.map(async (message) => {
      // If deposit is already finalized, we won't change its attestation status:
      if (message.status === "finalized") {
        return message;
      }

      // For v1 messages, fetch attestation by messageHash -> receive a single attestation in response
      const attestation = await _fetchCctpV1Attestation(message.messageHash, isMainnet);
      return {
        ...message,
        attestation: attestation?.attestation, // Will be undefined if status is "pending"
        status: utils.getPendingAttestationStatus(attestation),
      };
    })
  );
  return attestedMessages;
}

/**
 * @notice Returns the maxFee and finalityThreshold to set to transfer USDC via CCTP V2. If the finalityThreshold
 * is < 2000, then the transfer is a "fast" transfer and the maxFee is > 0.
 * @param originUsdcToken The address of the USDC token on the origin chain.
 * @param originChainId The chain ID of the origin chain.
 * @param destinationChainId The chain ID of the destination chain.
 * @param amount The amount of USDC to transfer.
 * @returns The maxFee (in units of USDC) and finalityThreshold to set to transfer USDC via CCTP V2.
 */
export async function getV2DepositForBurnMaxFee(
  originUsdcToken: Address,
  originChainId: number,
  destinationChainId: number,
  amount: BigNumber
): Promise<{ maxFee: BigNumber; finalityThreshold: number }> {
  const [_fastBurnAllowance, transferFees] = await Promise.all([
    utils.getV2FastBurnAllowance(chainIsProd(destinationChainId)),
    utils.getV2MinTransferFees(originChainId, destinationChainId),
  ]);
  const expectedMaxFastTransferFee = getV2MaxExpectedTransferFee(originChainId);
  // If we are using CCTP V2 then try to use the fast transfer if the amount is under the
  // fast burn allowance and the transfer fee is under the expected max fast transfer fee.
  // Fees are taken out of the received amount on the destination chain.
  let finalityThreshold = CCTPV2_FINALITY_THRESHOLD_STANDARD;
  let maxFee = bnZero;
  const { decimals } = getTokenInfo(originUsdcToken, originChainId);
  const fastBurnAllowance = toBNWei(_fastBurnAllowance, decimals);
  if (amount.lte(fastBurnAllowance) && transferFees.fast.lte(expectedMaxFastTransferFee)) {
    finalityThreshold = CCTPV2_FINALITY_THRESHOLD_FAST;
    // Set maxFee to the expected max fast transfer fee, which is larger and provides a buffer
    // in case the transfer fee moves. maxFee must be set higher than the minFee. Add a 1% buffer
    // to final amount to account for rounding errors.
    maxFee = amount.mul(transferFees.fast).div(10000).mul(101).div(100);
  }
  return {
    maxFee,
    finalityThreshold,
  };
}

/**
 * @notice Returns the maximum expected transfer fees that we can use to avoid overpaying for
 * fast transfers. Based on empirical observations.
 * @param sourceChainId The source chain ID of the transfer.
 * @returns The fee in basis points.
 */
export function getV2MaxExpectedTransferFee(sourceChainId: number): BigNumber {
  // Based on https://developers.circle.com/cctp/technical-guide#cctp-fees
  // as of 09/26/2025.
  switch (sourceChainId) {
    case CHAIN_IDs.LINEA:
      return BigNumber.from(14);
    case CHAIN_IDs.INK:
      return BigNumber.from(2);
    default:
      return BigNumber.from(1);
  }
}

export function getCctpV1TokenMessenger(tokenMessengerChainId: number): { address?: string; abi?: unknown[] } {
  return CONTRACT_ADDRESSES[tokenMessengerChainId]["cctpTokenMessenger"];
}

export function getCctpV2TokenMessenger(chainId: number): { address?: string; abi?: unknown[] } {
  return CONTRACT_ADDRESSES[chainId]["cctpV2TokenMessenger"];
}

export function getCctpV1MessageTransmitter(messageTransmitterChainId: number): { address?: string; abi?: unknown[] } {
  return CONTRACT_ADDRESSES[messageTransmitterChainId]["cctpMessageTransmitter"];
}

export function getCctpV2MessageTransmitter(chainId: number): { address?: string; abi?: unknown[] } {
  return CONTRACT_ADDRESSES[chainId]["cctpV2MessageTransmitter"];
}

/** ********************************************************************************************************************
 *
 * Internal functions and constants:
 *
 ******************************************************************************************************************* **/

async function _getDestinationMessageTransmitterContract(
  destinationChainId: number,
  cctpV1: boolean
): Promise<Contract> {
  const dstProvider = await getProvider(destinationChainId);
  const { address, abi } = cctpV1
    ? getCctpV1MessageTransmitter(destinationChainId)
    : getCctpV2MessageTransmitter(destinationChainId);
  return new ethers.Contract(address, abi, dstProvider);
}

/**
 * Gets all tx hashes that may be relevant for CCTPV1  finalization.
 * This includes:
 *  - All tx hashes where `DepositForBurn` events happened (for USDC transfers).
 *  - If source is hub chain, all txs where HubPool on `sourceChainId` emitted `MessageRelayed` or `TokensRelayed` events.
 *
 * @param srcProvider - Provider for the source chain.
 * @param sourceChainId - Chain ID where the messages/deposits originated.
 * @param destinationChainId - Chain ID where the messages/deposits are targeted.
 * @param senderAddresses - Addresses that initiated the `DepositForBurn` events.
 * @param sourceEventSearchConfig - Configuration for event searching on the source chain.
 * @returns A Set of unique transaction hashes.
 */
async function _getCCTPV1DepositAndMessageTxnHashes(
  srcProvider: Provider,
  sourceChainId: number,
  destinationChainId: number,
  _senderAddresses: EvmAddress[],
  sourceEventSearchConfig: EventSearchConfig
): Promise<Set<string>> {
  // This function only works with EVM source chains.
  assert(chainIsEvm(sourceChainId));
  const senderAddresses = _senderAddresses.map((address) => address.toNative());

  // Special case: The HubPool can initiate MessageSent events, which have no filters we can easily query on, so
  // we query for HubPool MessageRelayed events directly. These can theoretically appear without DepositForBurn events.
  const hubPool = CONTRACT_ADDRESSES[sourceChainId]?.hubPool;
  const isHubPoolAmongSenders =
    isDefined(hubPool) && senderAddresses.some((senderAddr) => compareAddressesSimple(senderAddr, hubPool.address));
  const txHashesFromHubPool: string[] = [];
  if (isHubPoolAmongSenders) {
    const hubPoolContract = new Contract(hubPool.address, hubPool.abi, srcProvider);

    const messageRelayedFilter = hubPoolContract.filters.MessageRelayed();
    const messageRelayedEvents = await paginatedEventQuery(
      hubPoolContract,
      messageRelayedFilter,
      sourceEventSearchConfig
    );
    messageRelayedEvents.forEach((e) => {
      txHashesFromHubPool.push(e.transactionHash);
    });
  }

  let depositForBurnEventTxnHashes: string[] = [];
  const { address, abi } = getCctpV1TokenMessenger(sourceChainId);
  const srcTokenMessenger = new Contract(address, abi, srcProvider);

  const eventFilterParams = [undefined, TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId], undefined, senderAddresses];
  const eventFilter = srcTokenMessenger.filters.DepositForBurn(...eventFilterParams);
  depositForBurnEventTxnHashes = (await paginatedEventQuery(srcTokenMessenger, eventFilter, sourceEventSearchConfig))
    .filter((e) => e.args.destinationDomain === getCctpDomainForChainId(destinationChainId))
    .map((e) => e.transactionHash);

  const uniqueTxHashes = new Set([...txHashesFromHubPool, ...depositForBurnEventTxnHashes]);

  return uniqueTxHashes;
}

async function _getCCTPV1MessageEvents(
  _senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<CCTPMessageEvent[]> {
  assert(chainIsEvm(sourceChainId));
  // At this point, we are going from EVM to EVM _or_ we are going from and EVM L1 to an SVM L2. Either way, we need to ensure that all
  // `senderAddresses` are EVM.
  const senderAddresses: EvmAddress[] = _senderAddresses
    .map((address) => (address.isEVM() ? address : undefined))
    .filter(isDefined);

  const srcProvider = getCachedProvider(sourceChainId);
  const uniqueTxHashes = await _getCCTPV1DepositAndMessageTxnHashes(
    srcProvider,
    sourceChainId,
    destinationChainId,
    senderAddresses,
    sourceEventSearchConfig
  );

  if (uniqueTxHashes.size === 0) {
    return [];
  }

  const receipts = await Promise.all(Array.from(uniqueTxHashes).map((hash) => srcProvider.getTransactionReceipt(hash)));

  const sourceDomainId = getCctpDomainForChainId(sourceChainId);
  const destinationDomainId = getCctpDomainForChainId(destinationChainId);
  const usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId];
  assert(isDefined(usdcAddress), `USDC address not defined for chain ${sourceChainId}`);

  const tokenMessengerInterface = new ethers.utils.Interface(getCctpV1TokenMessenger(sourceChainId).abi);
  const messageTransmitterInterface = new ethers.utils.Interface(getCctpV1MessageTransmitter(sourceChainId).abi);

  const relevantEvents: CCTPMessageEvent[] = [];
  for (const receipt of receipts) {
    const relevantEventsFromReceipt = _getCCTPV1EventsFromReceipt(
      receipt,
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
  messageTransmitterInterface: ethers.utils.Interface
): CommonMessageEvent {
  const eventData = _decodeCommonMessageDataV1(log);
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
  tokenMessengerInterface: ethers.utils.Interface
): DepositForBurnMessageEvent {
  const eventData = _decodeDepositForBurnMessageDataV1(messageSentLog);

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

/**
 * @notice Returns CCTP events organized as either Message or DepositForBurn events.
 * @returns list of Message and DepositForBurn events
 */
function _getCCTPV1EventsFromReceipt(
  receipt: ethers.providers.TransactionReceipt,
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
    const messageSentVersion = utils.getMessageSentVersion(log);
    const isV1MessageSentEvent = messageSentVersion === 0;

    if (isV1MessageSentEvent) {
      messageSentIndices.push(i);
      return; // Continue to next log
    }

    // Attempt to parse as `DepositForBurn`
    const depositForBurnVersion = utils.getDepositForBurnVersion(log);
    const isV1DepositForBurnEvent = depositForBurnVersion === 0;

    if (!isV1DepositForBurnEvent) {
      return; // Neither MessageSent nor DepositForBurn
    }

    if (messageSentIndices.length === 0) {
      throw new Error(
        "DepositForBurn event found without corresponding MessageSent event. Each DepositForBurn event must have a preceding MessageSent event in the same transaction. " +
          `Transaction: ${receipt.transactionHash}, DepositForBurn log index: ${i}`
      );
    }

    // Record a `MessageSent` + `DepositForBurn` pair into the `depositIndexPairs` array
    const correspondingMessageSentIndex = messageSentIndices.pop();
    depositIndexPairs.push([correspondingMessageSentIndex, i]);
  });

  // Process all the individual tokenless CCTP messages
  for (const messageSentIndex of messageSentIndices) {
    const event = _createMessageSentEvent(receipt.logs[messageSentIndex], messageTransmitterInterface);
    if (_isRelevantCCTPEvent(event, sourceDomainId, destinationDomainId, senderAddresses, usdcAddress)) {
      relevantEvents.push(event);
    }
  }

  // Process all the CCTP token transfers (each composed of 2 events)
  for (const [messageSentIndex, depositForBurnIndex] of depositIndexPairs) {
    const event = _createDepositForBurnMessageEvent(
      receipt.logs[messageSentIndex],
      receipt.logs[depositForBurnIndex],
      tokenMessengerInterface
    );
    if (_isRelevantCCTPEvent(event, sourceDomainId, destinationDomainId, senderAddresses, usdcAddress)) {
      relevantEvents.push(event);
    }
  }

  return relevantEvents;
}

async function _getCCTPV1MessagesWithStatus(
  senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  sourceEventSearchConfig: EventSearchConfig,
  signer?: KeyPairSigner
): Promise<AttestedCCTPMessage[]> {
  assert(chainIsEvm(sourceChainId));
  const cctpMessageEvents = await _getCCTPV1MessageEvents(
    senderAddresses,
    sourceChainId,
    destinationChainId,
    sourceEventSearchConfig
  );
  const dstProvider = getCachedProvider(destinationChainId);
  const { address, abi } = getCctpV1MessageTransmitter(destinationChainId);
  const messageTransmitterContract = chainIsSvm(destinationChainId)
    ? undefined
    : new Contract(address, abi, dstProvider);
  let svmProvider, latestBlockhash;
  if (chainIsSvm(destinationChainId)) {
    svmProvider = getSvmProvider(await getRedisCache());
    latestBlockhash = await svmProvider.getLatestBlockhash().send();
  }
  return await Promise.all(
    cctpMessageEvents.map(async (messageEvent) => {
      let processed;
      if (chainIsSvm(destinationChainId)) {
        assert(signer, "Signer is required for Solana CCTP messages");
        processed = await arch.svm.hasCCTPV1MessageBeenProcessed(
          svmProvider,
          signer,
          messageEvent.nonce,
          messageEvent.sourceDomain,
          latestBlockhash!.value
        );
      } else {
        processed = await utils.hasCCTPMessageBeenProcessedEvm(messageEvent.nonceHash, messageTransmitterContract);
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

async function _getCCTPV1DepositEventsSvm(
  senderAddresses: Address[],
  sourceChainId: number,
  destinationChainId: number,
  sourceEventSearchConfig: EventSearchConfig
): Promise<AttestedCCTPDeposit[]> {
  assert(chainIsSvm(sourceChainId));
  // Get the `DepositForBurn` events on Solana.
  const provider = getSvmProvider(await getRedisCache());
  const { address } = getCctpV1TokenMessenger(sourceChainId);

  const eventClient = await SvmCpiEventsClient.createFor(provider, address, TokenMessengerMinterIdl);
  const depositForBurnEvents = await eventClient.queryDerivedAddressEvents(
    "DepositForBurn",
    arch.svm.toAddress(SvmAddress.from(address)),
    BigInt(sourceEventSearchConfig.from),
    BigInt(sourceEventSearchConfig.to)
  );

  const dstProvider = getCachedProvider(destinationChainId);
  const { address: dstMessageTransmitterAddress, abi } = getCctpV1MessageTransmitter(destinationChainId);
  const destinationMessageTransmitter = new ethers.Contract(dstMessageTransmitterAddress, abi, dstProvider);

  // Query the CCTP API to get the encoded message bytes/attestation.
  // Return undefined if we need to filter out the deposit event.
  const _depositsWithAttestations = await mapAsync(depositForBurnEvents, async (event) => {
    const eventData = event.data as { depositor: string; destinationDomain: number };
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
      const attestationStatusObject = await _fetchCctpV1Attestation(
        decodedMessage.messageHash,
        chainIsProd(sourceChainId)
      );
      const alreadyProcessed = await utils.hasCCTPMessageBeenProcessedEvm(
        decodedMessage.nonceHash,
        destinationMessageTransmitter
      );
      return {
        ...decodedMessage,
        attestation: data.attestation,
        status: alreadyProcessed
          ? ("finalized" as utils.CCTPMessageStatus)
          : utils.getPendingAttestationStatus(attestationStatusObject),
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

/**
 * Decodes hookData from a CCTP V2 message if present.
 * hookData starts at byte 376 (148 header + 228 body offset) in CCTP V2 messages.
 * @param messageBytes The raw message bytes (hex string with 0x prefix)
 * @returns Decoded hookData or undefined if not present
 */
export function decodeCctpV2HookData(messageBytes: string): CCTPHookData | undefined {
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  // hookData starts at byte 376 (148 header + 228 body offset)
  const HOOK_DATA_START = 376;

  // Check if hookData exists (message is longer than 376 bytes)
  if (messageBytesArray.length <= HOOK_DATA_START) {
    return undefined;
  }

  const hookDataBytes = messageBytesArray.slice(HOOK_DATA_START);

  try {
    // Decode hookData: abi.encode(nonce, deadline, maxBpsToSponsor, maxUserSlippageBps, finalRecipient, finalToken, executionMode, actionData)
    const decoded = ethers.utils.defaultAbiCoder.decode(
      ["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint8", "bytes"],
      hookDataBytes
    );

    return {
      nonce: decoded[0],
      deadline: decoded[1].toString(),
      maxBpsToSponsor: decoded[2].toNumber(),
      maxUserSlippageBps: decoded[3].toNumber(),
      finalRecipient: EvmAddress.from(decoded[4]).toNative(),
      finalToken: EvmAddress.from(decoded[5]).toNative(),
      executionMode: decoded[6],
      actionData: decoded[7],
    };
  } catch {
    // If decoding fails, hookData is malformed or not present
    return undefined;
  }
}

/**
 * Generates an attestation proof for a given message hash. This is required to finalize a CCTP message.
 * @param messageHash The message hash to generate an attestation proof for. This is generated by taking the keccak256 hash of the message bytes of the initial transaction log.
 * @param isMainnet Whether or not the attestation proof should be generated on mainnet. If this is false, the attestation proof will be generated on the sandbox environment.
 * @returns The attestation status and proof for the given message hash. This is a string of the form "0x<attestation proof>". If the status is pending_confirmation
 * then the proof will be null according to the CCTP dev docs.
 * @link https://developers.circle.com/stablecoins/reference/getattestation
 */
async function _fetchCctpV1Attestation(
  messageHash: string,
  isMainnet: boolean
): Promise<CCTPV1APIGetAttestationResponse> {
  const httpResponse = await axios.get<CCTPV1APIGetAttestationResponse>(
    `https://iris-api${isMainnet ? "" : "-sandbox"}.circle.com/attestations/${messageHash}`
  );
  const attestationResponse = httpResponse.data;
  return attestationResponse;
}

async function _fetchCCTPSvmAttestationProof(transactionHash: string): Promise<CCTPV1APIGetMessagesResponse> {
  const httpResponse = await axios.get<CCTPV1APIGetMessagesResponse>(
    `https://iris-api.circle.com/messages/${getCctpDomainForChainId(CHAIN_IDs.SOLANA)}/${transactionHash}`
  );
  const attestationResponse = httpResponse.data;
  return attestationResponse;
}

/**
 * Checks and sets USDC approval for CCTP TokenMessenger if needed.
 * @param sourceChainId Chain ID where the approval is needed
 * @param sourceSigner Signer for the source chain
 * @param sourceUsdcTokenAddress USDC token address on source chain
 * @param tokenMessengerAddress CCTP TokenMessenger contract address
 * @param logger Optional logger for logging approval actions
 */
async function checkAndApproveCctpTokenMessenger(
  sourceChainId: number,
  sourceSigner: Signer,
  sourceUsdcTokenAddress: EvmAddress,
  tokenMessengerAddress: string,
  logger: winston.Logger
): Promise<void> {
  if (!chainIsEvm(sourceChainId)) {
    return;
  }
  const tokenMessengerEvmAddress = EvmAddress.from(tokenMessengerAddress);
  const signerAddress = await sourceSigner.getAddress();
  const signerEvmAddress = EvmAddress.from(signerAddress);

  // Check allowance (first from cache, then on-chain)
  const cachedAllowance = await getL2TokenAllowanceFromCache(
    sourceChainId,
    sourceUsdcTokenAddress,
    signerEvmAddress,
    tokenMessengerEvmAddress
  );
  const usdcContract = ERC20.connect(sourceUsdcTokenAddress.toNative(), sourceSigner);
  const allowance = cachedAllowance ?? (await usdcContract.allowance(signerAddress, tokenMessengerAddress));

  // Cache the allowance if we fetched it on-chain and it's sufficient
  if (!isDefined(cachedAllowance) && aboveAllowanceThreshold(allowance)) {
    await setL2TokenAllowanceInCache(
      sourceChainId,
      sourceUsdcTokenAddress,
      signerEvmAddress,
      tokenMessengerEvmAddress,
      allowance
    );
  }

  // Approve if needed
  if (!aboveAllowanceThreshold(allowance)) {
    const sourceChainName = getNetworkName(sourceChainId);
    logger.info({
      at: "checkAndApproveCctpTokenMessenger",
      message: "Approving USDC for CCTP TokenMessenger",
      chainName: sourceChainName,
      chainId: sourceChainId,
      tokenAddress: sourceUsdcTokenAddress.toNative(),
      tokenMessengerAddress,
    });

    // Use Mainnet as hub chain ID for approval
    await approveBridgeTokens(
      [{ token: usdcContract, bridges: [tokenMessengerEvmAddress] }],
      sourceChainId,
      CHAIN_IDs.MAINNET,
      logger
    );

    logger.info({
      at: "checkAndApproveCctpTokenMessenger",
      message: "✓ USDC approved for CCTP TokenMessenger",
      chainName: sourceChainName,
      chainId: sourceChainId,
    });
  }
}

/**
 * Constructs a CCTP depositForBurn transaction for L1->L2, L2->L2, or L2->L1 transfers.
 * This is a utility function extracted from UsdcCCTPBridge to be reusable.
 *
 * @param sourceChainId Source chain ID (L1 or L2)
 * @param destinationChainId Destination chain ID (L2 or L1)
 * @param sourceSigner Signer for the source chain
 * @param toAddress Recipient address on destination chain
 * @param sourceUsdcTokenAddress USDC token address on source chain
 * @param amount Amount to transfer (will be capped at CCTP_MAX_SEND_AMOUNT)
 * @param optionalParams Optional parameters including fastMode
 * @param hubChainId Optional hub chain ID (L1). If not provided, will be inferred from sourceChainId.
 *                   Required for L1->L2 transfers to determine L1 USDC address.
 * @returns AugmentedTransaction ready to be enqueued in MultiCallerClient
 */
export async function constructCctpDepositForBurnTxn(
  sourceChainId: number,
  destinationChainId: number,
  sourceSigner: Signer,
  toAddress: EvmAddress,
  sourceUsdcTokenAddress: EvmAddress,
  amount: BigNumber,
  logger: winston.Logger,
  optionalParams?: TransferTokenParams
): Promise<AugmentedTransaction> {
  const { address: tokenMessengerAddress, abi: tokenMessengerAbi } = getCctpV2TokenMessenger(sourceChainId);
  const bridgeContract = new Contract(tokenMessengerAddress, tokenMessengerAbi, sourceSigner);

  // Check and set CCTP TokenMessenger approval if needed
  await checkAndApproveCctpTokenMessenger(
    sourceChainId,
    sourceSigner,
    sourceUsdcTokenAddress,
    tokenMessengerAddress,
    logger
  );

  const { decimals } = getTokenInfo(sourceUsdcTokenAddress, sourceChainId);
  const formatter = createFormatFunction(2, 4, false, decimals);

  // Cap amount at CCTP_MAX_SEND_AMOUNT
  amount = amount.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amount;

  let maxFee = bnZero;
  let finalityThreshold = CCTPV2_FINALITY_THRESHOLD_STANDARD;
  if (optionalParams?.fastMode) {
    const feeResult = await getV2DepositForBurnMaxFee(
      sourceUsdcTokenAddress,
      sourceChainId,
      destinationChainId,
      amount
    );
    maxFee = feeResult.maxFee;
    finalityThreshold = feeResult.finalityThreshold;
  }

  // Add maxFee so that we end up with desired amount of tokens on destination chain.
  const amountWithFee = amount.add(maxFee);
  const amountToSend = amountWithFee.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amountWithFee;

  const sourceChainName = getNetworkName(sourceChainId);
  const destinationChainName = getNetworkName(destinationChainId);
  const destinationDomain = getCctpDomainForChainId(destinationChainId);

  return {
    contract: bridgeContract,
    chainId: sourceChainId,
    method: "depositForBurn",
    nonMulticall: true,
    message: `🎰 Bridged CCTP USDC from ${sourceChainName} to ${destinationChainName}${
      optionalParams?.fastMode ? " using fast mode" : ""
    }`,
    mrkdwn: `Bridged ${formatter(amountToSend)} USDC from ${sourceChainName} to ${destinationChainName} via CCTP${
      optionalParams?.fastMode ? ` using fast mode with a max fee of ${formatter(maxFee)}` : ""
    }`,
    args: [
      amountToSend,
      destinationDomain,
      toAddress.toBytes32(),
      sourceUsdcTokenAddress.toNative(),
      ethers.constants.HashZero, // Anyone can finalize the message on domain when this is set to bytes32(0)
      maxFee,
      finalityThreshold,
    ],
  };
}
