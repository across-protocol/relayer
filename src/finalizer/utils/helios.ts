import { HubPoolClient, SpokePoolClient, AugmentedTransaction } from "../../clients";
import {
  EventSearchConfig,
  Signer,
  winston,
  paginatedEventQuery,
  compareAddressesSimple,
  ethers,
  BigNumber,
} from "../../utils";
import { spreadEventWithBlockNumber } from "../../utils/EventUtils";
import { FinalizerPromise, CrossChainMessage } from "../types";
import { CONTRACT_ADDRESSES } from "../../common";
import axios from "axios";
import UNIVERSAL_SPOKE_ABI from "../../common/abi/Universal_SpokePool.json";
import { RelayedCallDataEvent, StoredCallDataEvent } from "../../interfaces/Universal";
import { ApiProofRequest, ProofOutputs, ProofStateResponse, SP1HeliosProofData } from "../../interfaces/ZkApi";
import { StorageSlotVerifiedEvent } from "../../interfaces/Helios";
import { calculateProofId, decodeProofOutputs } from "../../utils/ZkApiUtils";
import { calculateHubPoolStoreStorageSlot, getHubPoolStoreContract } from "../../utils/UniversalUtils";
import { stringifyThrownValue } from "../../utils/LogUtils";
import { getSp1HeliosContract } from "../../utils/HeliosUtils";

type CrossChainMessageStatus = "NeedsProofAndExecution" | "NeedsExecutionOnly";

interface PendingCrosschainMessage {
  l1Event: StoredCallDataEvent; // The original HubPoolStore event triggering the flow
  status: CrossChainMessageStatus;
  verifiedHead?: ethers.BigNumber; // Head from the StorageSlotVerified event, only present if status is NeedsExecutionOnly
}
// ---------------------------------------

// Type for successful proof data, augmented with HubPoolStore event info.
type SuccessfulProof = {
  proofData: SP1HeliosProofData;
  sourceNonce: ethers.BigNumber;
  target: string;
  sourceMessageData: string;
};

export async function heliosL1toL2Finalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _senderAddresses: string[]
): Promise<FinalizerPromise> {
  const l1ChainId = hubPoolClient.chainId;
  const l2ChainId = l2SpokePoolClient.chainId;

  // --- Step 1: Identify Pending Messages ---
  const pendingMessages = await identifyPendingHeliosMessages(
    logger,
    hubPoolClient,
    l1SpokePoolClient,
    l2SpokePoolClient,
    l1ChainId,
    l2ChainId
  );

  if (pendingMessages.length === 0) {
    logger.debug({
      at: `Finalizer#heliosL1toL2Finalizer:${l2ChainId}`,
      message: "No pending Helios messages found requiring action.",
    });
    return { callData: [], crossChainMessages: [] };
  }

  // Separate messages based on required action
  const needsProofAndExecution = pendingMessages.filter((m) => m.status === "NeedsProofAndExecution");
  const needsExecutionOnly = pendingMessages.filter((m) => m.status === "NeedsExecutionOnly");

  logger.debug({
    at: `Finalizer#heliosL1toL2Finalizer:${l2ChainId}`,
    message: `Identified ${pendingMessages.length} total pending messages.`,
    counts: {
      needsProofAndExecution: needsProofAndExecution.length,
      needsExecutionOnly: needsExecutionOnly.length,
    },
    needsExecutionNonces: needsExecutionOnly.map((m) => m.l1Event.nonce.toString()), // Log nonces needing only execution
  });

  // --- Step 2: Get Proofs for Messages Needing Full Finalization ---
  let proofsToSubmit: SuccessfulProof[] = [];
  if (needsProofAndExecution.length > 0) {
    // Pass only the messages that need proofs
    proofsToSubmit = await processUnfinalizedHeliosMessages(
      logger,
      needsProofAndExecution, // Pass PendingHeliosMessage[] here
      l2SpokePoolClient,
      l1ChainId
    );
    if (proofsToSubmit.length === 0) {
      logger.debug({
        at: `Finalizer#heliosL1toL2Finalizer:${l2ChainId}`,
        message: "No successful proofs retrieved for messages needing full finalization.",
      });
      // Don't return yet, might still have needsExecutionOnly messages
    }
  }

  // --- Step 3: Generate Multicall Data from Proofs and Partially Finalized Messages ---
  if (proofsToSubmit.length === 0 && needsExecutionOnly.length === 0) {
    logger.debug({
      at: `Finalizer#heliosL1toL2Finalizer:${l2ChainId}`,
      message: "No proofs obtained and no messages need execution only. Nothing to submit.",
    });
    return { callData: [], crossChainMessages: [] };
  }

  return generateHeliosTxns(logger, proofsToSubmit, needsExecutionOnly, l1ChainId, l2ChainId, l2SpokePoolClient);
}

// ==================================
// Step-by-step Helper Functions
// ==================================

/** --- Step 1 ---
 * Identifies messages stored on L1 HubPoolStore that require action on L2.
 * Fetches L1 StoredCallData events, L2 StorageSlotVerified events, and L2 RelayedCallData events.
 * Determines if a message needs both proof+execution or just execution or no actions.
 */
async function identifyPendingHeliosMessages(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  l1SpokePoolClient: SpokePoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1ChainId: number,
  l2ChainId: number
): Promise<PendingCrosschainMessage[]> {
  // --- Substep 1: Query and Filter L1 Events ---
  const relevantStoredCallDataEvents = await getRelevantL1Events(
    logger,
    hubPoolClient,
    l1SpokePoolClient,
    l1ChainId,
    l2ChainId,
    l2SpokePoolClient.spokePool.address
  );

  if (relevantStoredCallDataEvents.length === 0) {
    logger.debug({
      at: `Finalizer#identifyPendingHeliosMessages:${l2ChainId}`,
      message: "No relevant StoredCallData events found on L1.",
    });
    return [];
  }

  // --- Substep 2: Query L2 Verification Events (StorageSlotVerified) ---
  const verifiedSlotsMap = await getL2VerifiedSlotsMap(l2SpokePoolClient, l2ChainId);

  // --- Substep 3: Query L2 Execution Events (RelayedCallData) ---
  const relayedNonces = await getL2RelayedNonces(l2SpokePoolClient);

  // --- Determine Status for each L1 Event ---
  const pendingMessages: PendingCrosschainMessage[] = [];
  for (const l1Event of relevantStoredCallDataEvents) {
    const expectedStorageSlot = calculateHubPoolStoreStorageSlot(l1Event.nonce);
    const nonce = l1Event.nonce;

    const isExecuted = relayedNonces.has(nonce.toString()); // Use nonce string as key

    if (!isExecuted) {
      if (verifiedSlotsMap.has(expectedStorageSlot) /* isVerified */) {
        // Verified but not executed -> Needs Execution Only
        const verifiedEvent = verifiedSlotsMap.get(expectedStorageSlot);
        pendingMessages.push({
          l1Event: l1Event,
          status: "NeedsExecutionOnly",
          verifiedHead: verifiedEvent.head, // set verifiedHead as it's needed for execution
        });
        // Log a warning for partially finalized messages
        logger.warn({
          at: `Finalizer#identifyPendingHeliosMessages:${l2ChainId}`,
          message:
            "Message requires execution only (already verified in SP1Helios). Will generate SpokePool.executeMessage tx.",
          l1TxRef: l1Event.txnRef,
          nonce: nonce.toString(),
          storageSlot: expectedStorageSlot,
          verifiedOnL2TxnRef: verifiedEvent.txnRef,
          verifiedHead: verifiedEvent.head.toString(),
        });
      } else {
        // Not verified and not executed -> Needs Proof and Execution
        pendingMessages.push({
          l1Event: l1Event,
          status: "NeedsProofAndExecution",
          // verifiedHead is undefined here
        });
      }
    }
    // If `isExecuted` is true, the message is fully finalized, do nothing.
  }

  logger.debug({
    at: `Finalizer#identifyPendingHeliosMessages:${l2ChainId}`,
    message: "Finished identifying pending messages.",
    totalL1StoredCallData: relevantStoredCallDataEvents.length,
    totalL2VerifiedSlots: verifiedSlotsMap.size,
    totalL2RelayedNonces: relayedNonces.size,
    pendingMessagesCount: pendingMessages.length,
    needsProofCount: pendingMessages.filter((m) => m.status === "NeedsProofAndExecution").length,
    needsExecutionOnlyCount: pendingMessages.filter((m) => m.status === "NeedsExecutionOnly").length,
  });

  return pendingMessages;
}

/** Query and Filter L1 Events */
async function getRelevantL1Events(
  _logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  l1SpokePoolClient: SpokePoolClient,
  l1ChainId: number,
  _l2ChainId: number,
  l2SpokePoolAddress: string
): Promise<StoredCallDataEvent[]> {
  const l1Provider = hubPoolClient.hubPool.provider;
  const hubPoolStoreContract = getHubPoolStoreContract(l1ChainId, l1Provider);

  /**
   * @dev We artificially shorten the lookback time peiod for L1 events by a factor of 2. We want to avoid race conditions where
   * we see an old event on L1, but not look back far enough on L2 to see that the event has been executed successfully.
   */
  const toBlock = l1SpokePoolClient.latestBlockSearched;
  const fromBlock = Math.floor((l1SpokePoolClient.eventSearchConfig.fromBlock + toBlock) / 2);
  const l1SearchConfig: EventSearchConfig = {
    fromBlock: fromBlock,
    toBlock: toBlock,
    maxBlockLookBack: l1SpokePoolClient.eventSearchConfig.maxBlockLookBack,
  };

  const storedCallDataFilter = hubPoolStoreContract.filters.StoredCallData();

  const rawLogs = await paginatedEventQuery(hubPoolStoreContract, storedCallDataFilter, l1SearchConfig);

  const events: StoredCallDataEvent[] = rawLogs.map((log) => spreadEventWithBlockNumber(log) as StoredCallDataEvent);

  const relevantStoredCallDataEvents = events.filter(
    (event) =>
      compareAddressesSimple(event.target, l2SpokePoolAddress) ||
      compareAddressesSimple(event.target, ethers.constants.AddressZero)
  );

  return relevantStoredCallDataEvents;
}

/** Query L2 Verification Events and return verified slots map */
async function getL2VerifiedSlotsMap(
  l2SpokePoolClient: SpokePoolClient,
  l2ChainId: number
): Promise<Map<string, StorageSlotVerifiedEvent>> {
  const l2Provider = l2SpokePoolClient.spokePool.provider;
  const sp1HeliosContract = getSp1HeliosContract(l2ChainId, l2Provider);

  const l2SearchConfig: EventSearchConfig = {
    fromBlock: l2SpokePoolClient.eventSearchConfig.fromBlock,
    toBlock: l2SpokePoolClient.latestBlockSearched,
    maxBlockLookBack: l2SpokePoolClient.eventSearchConfig.maxBlockLookBack,
  };
  const storageVerifiedFilter = sp1HeliosContract.filters.StorageSlotVerified();

  const rawLogs = await paginatedEventQuery(sp1HeliosContract, storageVerifiedFilter, l2SearchConfig);

  // Use spreadEventWithBlockNumber and cast to the flattened type
  const events: StorageSlotVerifiedEvent[] = rawLogs.map(
    (log) => spreadEventWithBlockNumber(log) as StorageSlotVerifiedEvent
  );

  // Store events in a map keyed by the storage slot (key)
  const verifiedSlotsMap = new Map<string, StorageSlotVerifiedEvent>();
  events.forEach((event) => {
    // Handle potential duplicates (though unlikely with paginated query): favour latest block/logIndex
    const existing = verifiedSlotsMap.get(event.key);
    if (
      !existing ||
      event.blockNumber > existing.blockNumber ||
      (event.blockNumber === existing.blockNumber && event.logIndex > existing.logIndex)
    ) {
      verifiedSlotsMap.set(event.key, event);
    }
  });
  return verifiedSlotsMap;
}

/** --- Query L2 Execution Events (RelayedCallData) */
async function getL2RelayedNonces(l2SpokePoolClient: SpokePoolClient): Promise<Set<string>> {
  const l2Provider = l2SpokePoolClient.spokePool.provider;
  const l2SpokePoolAddress = l2SpokePoolClient.spokePool.address;
  const universalSpokePoolContract = new ethers.Contract(l2SpokePoolAddress, UNIVERSAL_SPOKE_ABI, l2Provider);

  const l2SearchConfig: EventSearchConfig = {
    fromBlock: l2SpokePoolClient.eventSearchConfig.fromBlock,
    toBlock: l2SpokePoolClient.latestBlockSearched,
    maxBlockLookBack: l2SpokePoolClient.eventSearchConfig.maxBlockLookBack,
  };
  const relayedCallDataFilter = universalSpokePoolContract.filters.RelayedCallData();

  const rawLogs = await paginatedEventQuery(universalSpokePoolContract, relayedCallDataFilter, l2SearchConfig);

  // Use spreadEventWithBlockNumber and cast to the flattened type
  const events: RelayedCallDataEvent[] = rawLogs.map((log) => spreadEventWithBlockNumber(log) as RelayedCallDataEvent);

  // Return a Set of nonces (as strings for easy comparison)
  return new Set<string>(events.map((event) => event.nonce.toString()));
}

/**
 * --- Get Proofs for Unfinalized Messages ---
 * Processes messages needing proof+execution by interacting with the ZK Proof API.
 * Returns a list of successfully retrieved proofs.
 */
async function processUnfinalizedHeliosMessages(
  logger: winston.Logger,
  messagesToProcess: PendingCrosschainMessage[],
  l2SpokePoolClient: SpokePoolClient,
  l1ChainId: number
): Promise<SuccessfulProof[]> {
  // Filter within the function just in case, though the caller should have already filtered
  const unfinalizedMessages = messagesToProcess.filter((m) => m.status === "NeedsProofAndExecution");
  if (unfinalizedMessages.length === 0) {
    return [];
  }

  const l2ChainId = l2SpokePoolClient.chainId;
  const l2Provider = l2SpokePoolClient.spokePool.provider;
  const apiBaseUrl = process.env.HELIOS_PROOF_API_URL;

  if (!apiBaseUrl) {
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:processUnfinalizedHeliosMessages:${l2ChainId}`,
      message: "HELIOS_PROOF_API_URL environment variable not set. Cannot process Helios messages.",
    });
    return [];
  }

  const hubPoolStoreInfo = CONTRACT_ADDRESSES[l1ChainId]?.hubPoolStore;
  if (!hubPoolStoreInfo?.address) {
    throw new Error(`HubPoolStore address not available for chain: ${l1ChainId}. Cannot process Helios messages.`);
  }
  const hubPoolStoreAddress = hubPoolStoreInfo.address;
  const sp1HeliosContract = getSp1HeliosContract(l2ChainId, l2Provider);

  const headBn: ethers.BigNumber = await sp1HeliosContract.head();
  // todo: well, currently we're taking currentHead to use as prevHead in our ZK proof. There's a particular scenario where we could speed up proofs
  // todo: (by not making them to wait for finality longer than needed) if our blockNumber that we need a proved slot for is older than this head.
  const currentHead = headBn.toNumber();
  const currentHeader = await sp1HeliosContract.headers(headBn);
  if (!currentHeader || currentHeader === ethers.constants.HashZero) {
    throw new Error(`Invalid header found for head ${currentHead}`);
  }

  const successfulProofs: SuccessfulProof[] = [];

  // todo? Can use Promise.All if we really want to
  // Process messages one by one
  for (const pendingMessage of unfinalizedMessages) {
    const l1Event = pendingMessage.l1Event; // Extract the L1 event
    const logContext = {
      at: `Finalizer#heliosL1toL2Finalizer:processUnfinalizedHeliosMessages:${l2ChainId}`,
      l1TxHash: l1Event.txnRef,
      nonce: l1Event.nonce.toString(),
      target: l1Event.target,
    };

    const storageSlot = calculateHubPoolStoreStorageSlot(l1Event.nonce);

    const apiRequest: ApiProofRequest = {
      src_chain_contract_address: hubPoolStoreAddress,
      src_chain_storage_slot: storageSlot,
      src_chain_block_number: l1Event.blockNumber, // Use block number from L1 event
      dst_chain_contract_from_head: currentHead,
      dst_chain_contract_from_header: currentHeader,
    };

    const proofId = calculateProofId(apiRequest);
    const getProofUrl = `${apiBaseUrl}/api/proofs/${proofId}`;

    logger.debug({ ...logContext, message: "Attempting to get proof", proofId, getProofUrl, storageSlot });

    let proofState: ProofStateResponse | null = null;

    // @dev We need try - catch here because of how API responds to non-existing proofs: with NotFound status
    let getError: any = null;
    try {
      const response = await axios.get<ProofStateResponse>(getProofUrl);
      proofState = response.data;
      logger.debug({ ...logContext, message: "Proof state received", proofId, status: proofState.status });
    } catch (error: any) {
      getError = error;
    }

    // Axios error. Handle based on whether was a NOTFOUND or another error
    if (getError) {
      const isNotFoundError = axios.isAxiosError(getError) && getError.response?.status === 404;
      if (isNotFoundError) {
        // NOTFOUND error -> Request proof
        logger.debug({ ...logContext, message: "Proof not found (404), requesting...", proofId });
        await axios.post(`${apiBaseUrl}/api/proofs`, apiRequest);
        logger.debug({ ...logContext, message: "Proof requested successfully.", proofId });
        continue;
      } else {
        // If other error is returned -- throw and alert PD; this shouldn't happen
        throw new Error(`Failed to get proof state for proofId ${proofId}: ${stringifyThrownValue(getError)}`);
      }
    }

    // No axios error, process `proofState`
    switch (proofState.status) {
      case "pending":
        // If proof generation is pending -- there's nothing for us to do yet. Will check this proof next run
        logger.debug({ ...logContext, message: "Proof generation is pending.", proofId });
        break;
      case "errored":
        // Proof generation errored on the API side. This is concerning, so we log an error. But nothing to do for us other than to re-request
        logger.error({
          ...logContext,
          message: "Proof generation errored on ZK API side. Requesting again.",
          proofId,
          errorMessage: proofState.error_message,
        });

        await axios.post(`${apiBaseUrl}/api/proofs`, apiRequest);
        logger.debug({ ...logContext, message: "Errored proof requested again successfully.", proofId });
        break;
      case "success":
        if (!proofState.update_calldata) {
          throw new Error(`Proof status is success but update_calldata is missing for proofId ${proofId}`);
        }
        logger.debug({ ...logContext, message: "Proof successfully retrieved.", proofId });
        successfulProofs.push({
          // @dev `proofData` should exist if proofState.status is "success"
          proofData: proofState.update_calldata,
          sourceNonce: l1Event.nonce,
          target: l1Event.target,
          sourceMessageData: l1Event.data,
        });
        break;
      default:
        throw new Error(`Received unexpected proof status for proof ${proofId}`);
    }
  } // end loop over messages

  return successfulProofs;
}

/** --- Generate Multicall Data --- */
async function generateHeliosTxns(
  logger: winston.Logger,
  successfulProofs: SuccessfulProof[],
  needsExecutionOnlyMessages: PendingCrosschainMessage[],
  l1ChainId: number,
  l2ChainId: number,
  l2SpokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  const transactions: AugmentedTransaction[] = [];
  const crossChainMessages: CrossChainMessage[] = [];

  const sp1HeliosContract = getSp1HeliosContract(l2ChainId, l2SpokePoolClient.spokePool.signer);
  const spokePoolAddress = l2SpokePoolClient.spokePool.address;
  const universalSpokePoolContract = new ethers.Contract(
    spokePoolAddress,
    [...UNIVERSAL_SPOKE_ABI],
    l2SpokePoolClient.spokePool.signer
  );

  // --- Process messages needing only execution ---
  for (const message of needsExecutionOnlyMessages) {
    const { l1Event, verifiedHead } = message;
    const nonce = l1Event.nonce;
    const l1Target = l1Event.target; // Get target from L1 event
    const l1Data = l1Event.data; // Get data from L1 event

    if (!verifiedHead) {
      // @dev This shouldn't happen. If it does, there's a bug that needs fixing.
      throw new Error(`Logic error: Message ${nonce.toString()} needs execution only but verifiedHead is missing.`);
    }

    // @dev Warn about messages that require only half of finalization. Means that either a tx from prev. run got stuck or failed or something else weird happened
    logger.warn({
      at: `Finalizer#heliosL1toL2Finalizer:generateTxnItem:${l2ChainId}`,
      message: "Generating SpokePool.executeMessage ONLY for partially finalized message.",
      nonce: nonce.toString(),
      l1TxHash: l1Event.txnRef,
      verifiedHead: verifiedHead.toString(),
    });

    // --- Encode the message parameter ---
    const encodedMessage = ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [l1Target, l1Data]);
    // ------------------------------------

    const executeArgs = [nonce, encodedMessage, verifiedHead]; // Use encodedMessage
    const executeTx: AugmentedTransaction = {
      contract: universalSpokePoolContract,
      chainId: l2ChainId,
      method: "executeMessage",
      args: executeArgs,
      unpermissioned: true,
      canFailInSimulation: true,
      message: `Finalize Helios msg (HubPoolStore nonce ${nonce.toString()}) - Step 2 ONLY: Execute on SpokePool`,
    };
    transactions.push(executeTx);
    crossChainMessages.push({
      type: "misc",
      miscReason: "ZK bridge finalization (Execute Message Only)",
      originationChainId: l1ChainId,
      destinationChainId: l2ChainId,
    });
  }

  // --- Process messages needing proof and execution ---
  for (const proof of successfulProofs) {
    // Ensure the hex strings have the '0x' prefix, adding it only if missing.
    const proofBytes = proof.proofData.proof.startsWith("0x") ? proof.proofData.proof : "0x" + proof.proofData.proof;
    const publicValuesBytes = proof.proofData.public_values.startsWith("0x")
      ? proof.proofData.public_values
      : "0x" + proof.proofData.public_values;

    // @dev Will throw on decode errors here.
    const decodedOutputs: ProofOutputs = decodeProofOutputs(publicValuesBytes);

    // 1. SP1Helios.update transaction
    const updateArgs = [proofBytes, publicValuesBytes];
    const updateTx: AugmentedTransaction = {
      contract: sp1HeliosContract,
      chainId: l2ChainId,
      method: "update",
      args: updateArgs,
      unpermissioned: false,
      canFailInSimulation: false,
      nonMulticall: true,
      message: `Finalize Helios msg (HubPoolStore nonce ${proof.sourceNonce.toString()}) - Step 1: Update SP1Helios`,
    };
    transactions.push(updateTx);
    crossChainMessages.push({
      type: "misc",
      miscReason: "ZK bridge finalization (Helios Update)",
      originationChainId: l1ChainId,
      destinationChainId: l2ChainId,
    });

    // 2. SpokePool.executeMessage transaction
    // --- Encode the message parameter ---
    const l1Target = proof.target; // Get target from SuccessfulProof
    const l1Data = proof.sourceMessageData; // Get data from SuccessfulProof
    const encodedMessage = ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [l1Target, l1Data]);
    // ------------------------------------

    const executeArgs = [proof.sourceNonce, encodedMessage, decodedOutputs.newHead]; // Use encodedMessage
    const executeTx: AugmentedTransaction = {
      contract: universalSpokePoolContract,
      chainId: l2ChainId,
      method: "executeMessage",
      args: executeArgs,
      unpermissioned: true,
      // @dev Simulation of `executeMessage` depends on prior state update via SP1Helios.update
      canFailInSimulation: true,
      // todo? this hardcoded gas limit of 2 mil could be improved if we were able to simulate this tx on top of blockchain state created by the tx above
      gasLimit: BigNumber.from(2000000),
      message: `Finalize Helios msg (HubPoolStore nonce ${proof.sourceNonce.toString()}) - Step 2: Execute on SpokePool`,
    };
    transactions.push(executeTx);
    crossChainMessages.push({
      type: "misc",
      miscReason: "ZK bridge finalization (Execute Message)",
      originationChainId: l1ChainId,
      destinationChainId: l2ChainId,
    });
  }

  const totalFinalizations = successfulProofs.length + needsExecutionOnlyMessages.length;
  logger.debug({
    at: `Finalizer#heliosL1toL2Finalizer:generateHeliosTxns:${l2ChainId}`,
    message: `Generated ${transactions.length} transactions for ${totalFinalizations} finalizations (${successfulProofs.length} full, ${needsExecutionOnlyMessages.length} exec only).`,
    proofNoncesFinalized: successfulProofs.map((p) => p.sourceNonce.toString()),
    execOnlyNoncesFinalized: needsExecutionOnlyMessages.map((m) => m.l1Event.nonce.toString()),
  });

  return { callData: transactions, crossChainMessages: crossChainMessages };
}
