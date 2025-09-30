import { TransactionRequest } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { SpokePoolClient } from "../../../clients";
import {
  Contract,
  TOKEN_SYMBOLS_MAP,
  assert,
  groupObjectCountsByProp,
  winston,
  convertFromWei,
  EventSearchConfig,
  chainIsSvm,
  forEachAsync,
  getCachedProvider,
  EvmAddress,
  getNetworkName,
  mapAsync,
  CHAIN_IDs,
  getProvider,
  chainIsProd,
} from "../../../utils";
import {
  getPendingAttestationStatus,
  hasCCTPMessageBeenProcessedEvm,
  CCTPV2APIAttestation,
  fetchCctpV2Attestations,
  getCctpDestinationChainFromDomain,
  getCctpV2DepositForBurnTxnHashes,
  getCctpV2MessageTransmitter,
  isCctpV2L2ChainId,
} from "../../../utils/CCTPUtils";
import { FinalizerPromise, AddressesToFinalize } from "../../types";

/**
 * @notice This finalizes only CCTP V2 token relays that emit DepositForBurn events and where the sender or
 * recipient addresses are in the list of addressesToFinalize passed in.
 * @param logger
 * @param spokePoolClient Origin chain spoke pool client
 * @param addressesToFinalize Addresses sending or receiving Deposits that we want to finalize for.
 * @returns
 */
export async function cctpV2Finalizer(
  logger: winston.Logger,
  spokePoolClient: SpokePoolClient,
  addressesToFinalize: AddressesToFinalize
): Promise<FinalizerPromise> {
  const searchConfig: EventSearchConfig = {
    from: spokePoolClient.eventSearchConfig.from,
    to: spokePoolClient.latestHeightSearched,
    maxLookBack: spokePoolClient.eventSearchConfig.maxLookBack,
  };
  const sourceChainId = spokePoolClient.chainId;
  assert(!chainIsSvm(sourceChainId), "cctpFinalizer only supports EVM chains");

  const senderAndRecipientAddresses = Array.from(addressesToFinalize.keys());

  // Get all DepositForBurn events from source chain sent from one of the addresses in addressesToFinalize.
  const sourceProvider = getCachedProvider(sourceChainId);
  const depositForBurnEvents = await getCctpV2DepositForBurnTxnHashes(
    sourceProvider,
    sourceChainId,
    senderAndRecipientAddresses,
    searchConfig
  );

  // Fetch attestations for all deposit burn event transaction hashes. Note, some events might share the same
  // transaction hash, so only fetch attestations for unique transaction hashes.
  const uniqueTxHashes = Object.keys(depositForBurnEvents);
  const attestationResponses = await fetchCctpV2Attestations(uniqueTxHashes, spokePoolClient.chainId);

  // Categorize deposits based on status:
  const pendingDepositTxnHashes: string[] = [];
  const finalizedDepositTxnHashes: { txnHash: string; destinationChainId: number }[] = [];
  const readyToFinalizeDeposits: {
    txnHash: string;
    destinationChainId: number;
    attestationData: CCTPV2APIAttestation;
  }[] = [];
  await forEachAsync(Object.entries(attestationResponses), async ([txnHash, attestations]) => {
    await forEachAsync(attestations.messages, async (attestation) => {
      if (attestation.cctpVersion !== 2) {
        return;
      }
      // API has not produced an attestation for this deposit yet:
      if (getPendingAttestationStatus(attestation) === "pending") {
        pendingDepositTxnHashes.push(txnHash);
        logger.debug({
          at: `Finalizer#CCTPV2AnyToAnyFinalizer:${sourceChainId}`,
          message: "Attestation is pending confirmations",
          txnHash,
        });
        return;
      }

      // Filter out deposits for destinations that are not one of our supported CCTP V2 chains:
      const destinationChainId = getCctpDestinationChainFromDomain(
        attestation.decodedMessage.destinationDomain,
        chainIsProd(sourceChainId)
      );
      if (destinationChainId !== CHAIN_IDs.MAINNET && !isCctpV2L2ChainId(destinationChainId)) {
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
        logger.debug({
          at: `Finalizer#CCTPV2AnyToAnyFinalizer:${sourceChainId}`,
          message: "Skipping attestation because neither its sender nor recipient are in the addressesToFinalize list",
          sender,
          recipient,
          senderAndRecipientAddresses,
          txnHash,
          attestation,
        });
        return;
      }

      // If API attestationstatus  is "complete", then we need to check whether it has been already finalized:
      const destinationMessageTransmitter = await getDestinationMessageTransmitter(destinationChainId);
      const processed = await hasCCTPMessageBeenProcessedEvm(attestation.eventNonce, destinationMessageTransmitter);
      if (processed) {
        finalizedDepositTxnHashes.push({ txnHash, destinationChainId });
      } else {
        readyToFinalizeDeposits.push({ txnHash, destinationChainId, attestationData: attestation });
      }
    });
  });
  const finalizedGrouped = groupObjectCountsByProp(
    finalizedDepositTxnHashes,
    (deposit: { txnHash: string; destinationChainId: number }) => getNetworkName(deposit.destinationChainId)
  );
  const readyToFinalizeGrouped = groupObjectCountsByProp(
    readyToFinalizeDeposits,
    (deposit: { txnHash: string; destinationChainId: number }) => getNetworkName(deposit.destinationChainId)
  );
  logger.debug({
    at: `Finalizer#CCTPV2AnyToAnyFinalizer:${sourceChainId}`,
    message: `Detected ${
      readyToFinalizeDeposits.length
    } ready to finalize messages originating from CCTP on ${getNetworkName(sourceChainId)}`,
    pending: pendingDepositTxnHashes.length,
    finalized: finalizedGrouped,
    readyToFinalize: readyToFinalizeGrouped,
  });
  return {
    crossChainMessages: readyToFinalizeDeposits.map((attestation) => ({
      l1TokenSymbol: "USDC", // Always USDC b/c that's the only token we support on CCTP
      amount: convertFromWei(
        attestation.attestationData.decodedMessage.decodedMessageBody.amount,
        TOKEN_SYMBOLS_MAP.USDC.decimals
      ),
      type: "withdrawal",
      originationChainId: sourceChainId,
      destinationChainId: attestation.destinationChainId,
    })),
    callData: await mapAsync(readyToFinalizeDeposits, async (attestation) => {
      const messageTransmitter = await getDestinationMessageTransmitter(attestation.destinationChainId);
      const txn = (await messageTransmitter.populateTransaction.receiveMessage(
        attestation.attestationData.message,
        attestation.attestationData.attestation
      )) as TransactionRequest;
      return {
        target: txn.to,
        callData: txn.data,
      };
    }),
  };
}

async function getDestinationMessageTransmitter(destinationChainId: number): Promise<Contract> {
  const dstProvider = await getProvider(destinationChainId);
  const { address, abi } = getCctpV2MessageTransmitter(destinationChainId);
  return new ethers.Contract(address, abi, dstProvider);
}
