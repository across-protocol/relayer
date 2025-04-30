import { ethers } from "ethers";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import {
  EventSearchConfig,
  Signer,
  Multicall2Call,
  winston,
  paginatedEventQuery,
  compareAddressesSimple,
} from "../../utils";
import { FinalizerPromise, CrossChainMessage } from "../types";
import { getSp1Helios } from "../../utils/Sp1HeliosUtils";
import { Log } from "../../interfaces";
import { CONTRACT_ADDRESSES } from "../../common";
import axios from "axios";
// --- Structs ---
import { AugmentedTransaction } from "../../clients";

// Define interfaces for the event arguments for clarity
interface StoredCallDataEventArgs {
  target: string;
  data: string;
  nonce: ethers.BigNumber;
}

interface StorageSlotVerifiedEventArgs {
  head: ethers.BigNumber;
  key: string; // bytes32
  value: string; // bytes32
  contractAddress: string;
}

// Type for the structured StoredCallData event
type StoredCallDataEvent = Log & { args: StoredCallDataEventArgs };
// Type for the structured StorageSlotVerified event
type StorageSlotVerifiedEvent = Log & { args: StorageSlotVerifiedEventArgs };

// --- API Interaction Types ---
interface ApiProofRequest {
  src_chain_contract_address: string;
  src_chain_storage_slot: string;
  src_chain_block_number: number; // Changed from u64 for JS compatibility
  dst_chain_contract_from_head: number; // Changed from u64 for JS compatibility
  dst_chain_contract_from_header: string;
}

type ProofStatus = "pending" | "success" | "errored";

interface SP1HeliosProofData {
  proof: string;
  public_values: string;
}

interface ProofStateResponse {
  proof_id: string;
  status: ProofStatus;
  update_calldata?: SP1HeliosProofData; // Present only if status is "success"
  error_message?: string; // Present only if status is "errored"
}

// Define the structure for ProofOutputs to decode public_values
const proofOutputsAbiTuple = `tuple(
    bytes32 executionStateRoot,
    bytes32 newHeader,
    bytes32 nextSyncCommitteeHash,
    uint256 newHead,
    bytes32 prevHeader,
    uint256 prevHead,
    bytes32 syncCommitteeHash,
    bytes32 startSyncCommitteeHash,
    tuple(bytes32 key, bytes32 value, address contractAddress)[] slots
)`;

// Type for the decoded ProofOutputs structure
type DecodedProofOutputs = {
  executionStateRoot: string;
  newHeader: string;
  nextSyncCommitteeHash: string;
  newHead: ethers.BigNumber; // Access the newHead value
  prevHeader: string;
  prevHead: ethers.BigNumber;
  syncCommitteeHash: string;
  startSyncCommitteeHash: string;
  slots: { key: string; value: string; contractAddress: string }[]; // Added contractAddress
};

// Type for successful proof data, augmented with source info.
type SuccessfulProof = {
  proofData: SP1HeliosProofData;
  sourceNonce: ethers.BigNumber;
  target: string;
  sourceMessageData: string; // Original calldata from HubPoolStore event
};

export async function heliosL1toL2Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient, // Used for filtering target address
  l1SpokePoolClient: SpokePoolClient,
  _senderAddresses: string[]
): Promise<FinalizerPromise> {
  const l1ChainId = hubPoolClient.chainId;
  const l2ChainId = l2SpokePoolClient.chainId;
  const l2SpokePoolAddress = l2SpokePoolClient.spokePool.address; // Get L2 SpokePool address

  // --- Step 1: Query and Filter L1 Events ---
  // ✅ Step 1 tested and working
  const relevantStoredCallDataEvents = await getAndFilterL1Events(
    logger,
    hubPoolClient,
    l1SpokePoolClient,
    l1ChainId,
    l2ChainId,
    l2SpokePoolAddress
  );

  // ---- START BSC TEST CODE ----
  logger.info({
    at: `Finalizer#heliosL1toL2Finalizer:DEBUG_STEP_1:${l2ChainId}`,
    message: "--- DEBUGGING STEP 1: StoredCallData Events ---",
    count: relevantStoredCallDataEvents?.length ?? "null",
    events: relevantStoredCallDataEvents // Log the actual events for inspection
      ? relevantStoredCallDataEvents.map((e) => ({
          txHash: e.transactionHash,
          blockNumber: e.blockNumber,
          target: e.args.target,
          nonce: e.args.nonce.toString(),
          dataLength: e.args.data.length,
          data: e.args.data,
        }))
      : "null",
  });
  logger.info({
    at: `Finalizer#heliosL1toL2Finalizer:DEBUG_STEP_1:${l2ChainId}`,
    message: "--- RETURNING EARLY AFTER STEP 1 FOR TESTING ---",
  });
  // ---- END BSC TEST CODE ----

  if (!relevantStoredCallDataEvents || relevantStoredCallDataEvents.length === 0) {
    return { callData: [], crossChainMessages: [] };
  }

  // --- Step 2: Query L2 Verification Events ---
  // ✅ Step 2 tested and working
  const verifiedKeys = await getL2VerifiedKeys(logger, l2SpokePoolClient, l2ChainId);

  // ---- START BSC TEST CODE (STEP 2) ----
  logger.info({
    at: `Finalizer#heliosL1toL2Finalizer:DEBUG_STEP_2:${l2ChainId}`,
    message: "--- DEBUGGING STEP 2: Verified Keys ---",
    count: verifiedKeys?.size ?? "null (error occurred)",
    keys: verifiedKeys ? [...verifiedKeys] : "null (error occurred)", // Convert Set to Array for logging
  });
  // ---- END BSC TEST CODE (STEP 2) ----

  if (verifiedKeys === null) {
    // Indicates an error occurred fetching L2 events
    return { callData: [], crossChainMessages: [] };
  }

  // --- Step 3: Identify Unfinalized Messages ---
  // ✅ Step 3 tested and working
  const unfinalizedMessages = findUnfinalizedMessages(logger, relevantStoredCallDataEvents, verifiedKeys, l2ChainId);
  // todo: Testing, uncomment above after
  // const unfinalizedMessages = relevantStoredCallDataEvents;

  // ---- START BSC TEST CODE (STEP 3) ----
  logger.info({
    at: `Finalizer#heliosL1toL2Finalizer:DEBUG_STEP_3:${l2ChainId}`,
    message: "--- DEBUGGING STEP 3: Unfinalized Messages ---",
    count: unfinalizedMessages.length,
    messages: unfinalizedMessages.map((m) => ({
      txHash: m.transactionHash,
      blockNumber: m.blockNumber,
      target: m.args.target,
      nonce: m.args.nonce.toString(),
      // Optionally calculate expected slot for verification
      expectedSlot: calculateHubPoolStoreStorageSlot(m.args),
    })),
  });
  // ---- END BSC TEST CODE (STEP 3) ----

  if (unfinalizedMessages.length === 0) {
    return { callData: [], crossChainMessages: [] };
  }

  // --- Step 4: Get Proofs for Unfinalized Messages ---
  // ✅ Step 4. tested and working. Didn't test ALL branches; but happy-cases work
  const proofsToSubmit = await processUnfinalizedHeliosMessages(
    logger,
    unfinalizedMessages, // Pass the unfinalized messages containing original event data
    l2SpokePoolClient,
    l1ChainId
  );
  if (proofsToSubmit.length === 0) {
    logger.info({
      at: `Finalizer#heliosL1toL2Finalizer:${l2ChainId}`,
      message: "No successful proofs retrieved to submit.",
    });
    return { callData: [], crossChainMessages: [] };
  }

  // --- Step 5: Generate Multicall Data from Proofs ---
  return generateHeliosTxns(logger, proofsToSubmit, l1ChainId, l2ChainId, l2SpokePoolClient, signer);
}

// ==================================
// Step-by-step Helper Functions
// ==================================

/** STEP 1: Query and Filter L1 Events */
async function getAndFilterL1Events(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  l1SpokePoolClient: SpokePoolClient,
  l1ChainId: number,
  l2ChainId: number,
  l2SpokePoolAddress: string
): Promise<StoredCallDataEvent[] | null> {
  const l1Provider = hubPoolClient.hubPool.provider; // Get provider from HubPoolClient

  const hubPoolStoreInfo = CONTRACT_ADDRESSES[l1ChainId]?.hubPoolStore;
  if (!hubPoolStoreInfo?.address || !hubPoolStoreInfo.abi) {
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:getAndFilterL1Events:${l2ChainId}`,
      message: `HubPoolStore contract address or ABI not found for L1 chain ${l1ChainId}.`,
    });
    return null;
  }

  const hubPoolStoreContract = new ethers.Contract(hubPoolStoreInfo.address, hubPoolStoreInfo.abi as any, l1Provider);

  const l1SearchConfig: EventSearchConfig = {
    fromBlock: l1SpokePoolClient.eventSearchConfig.fromBlock,
    toBlock: l1SpokePoolClient.latestBlockSearched,
    maxBlockLookBack: l1SpokePoolClient.eventSearchConfig.maxBlockLookBack,
  };

  const storedCallDataFilter = hubPoolStoreContract.filters.StoredCallData();

  try {
    logger.debug({
      at: `Finalizer#heliosL1toL2Finalizer:getAndFilterL1Events:${l2ChainId}`,
      message: `Querying StoredCallData events on L1 (${l1ChainId})`,
      hubPoolStoreAddress: hubPoolStoreInfo.address,
      fromBlock: l1SearchConfig.fromBlock,
      toBlock: l1SearchConfig.toBlock,
    });

    const rawLogs = await paginatedEventQuery(hubPoolStoreContract, storedCallDataFilter, l1SearchConfig);

    // Explicitly cast logs to the correct type
    const events: StoredCallDataEvent[] = rawLogs.map((log) => ({
      ...log,
      args: log.args as StoredCallDataEventArgs,
    }));

    logger.info({
      at: `Finalizer#heliosL1toL2Finalizer:getAndFilterL1Events:${l2ChainId}`,
      message: `Found ${events.length} StoredCallData events on L1 (${l1ChainId})`,
    });

    const relevantStoredCallDataEvents = events.filter(
      (event) =>
        compareAddressesSimple(event.args.target, l2SpokePoolAddress) ||
        compareAddressesSimple(event.args.target, ethers.constants.AddressZero)
    );

    logger.info({
      at: `Finalizer#heliosL1toL2Finalizer:getAndFilterL1Events:${l2ChainId}`,
      message: `Filtered ${events.length} StoredCallData events down to ${relevantStoredCallDataEvents.length} relevant targets (${l2SpokePoolAddress} or zero address).`,
    });

    return relevantStoredCallDataEvents;
  } catch (error) {
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:getAndFilterL1Events:${l2ChainId}`,
      message: `Failed to query StoredCallData events from L1 (${l1ChainId})`,
      hubPoolStoreAddress: hubPoolStoreInfo.address,
      error,
    });
    return null; // Return null on error
  }
}

/** STEP 2: Query L2 Verification Events and return verified keys */
async function getL2VerifiedKeys(
  logger: winston.Logger,
  l2SpokePoolClient: SpokePoolClient,
  l2ChainId: number
): Promise<Set<string> | null> {
  const l2Provider = l2SpokePoolClient.spokePool.provider; // Get provider from L2 client

  const { address: sp1HeliosAddress, abi: sp1HeliosAbi } = getSp1Helios(l2ChainId);
  if (!sp1HeliosAddress || !sp1HeliosAbi) {
    logger.warn({
      at: `Finalizer#heliosL1toL2Finalizer:getL2VerifiedKeys:${l2ChainId}`,
      message: `SP1Helios contract not found for destination chain ${l2ChainId}. Cannot verify Helios messages.`,
    });
    return null;
  }
  const sp1HeliosContract = new ethers.Contract(sp1HeliosAddress, sp1HeliosAbi as any, l2Provider);

  const l2SearchConfig: EventSearchConfig = {
    fromBlock: l2SpokePoolClient.eventSearchConfig.fromBlock,
    toBlock: l2SpokePoolClient.latestBlockSearched,
    maxBlockLookBack: l2SpokePoolClient.eventSearchConfig.maxBlockLookBack,
  };
  const storageVerifiedFilter = sp1HeliosContract.filters.StorageSlotVerified();

  try {
    logger.debug({
      at: `Finalizer#heliosL1toL2Finalizer:getL2VerifiedKeys:${l2ChainId}`,
      message: `Querying StorageSlotVerified events on L2 (${l2ChainId})`,
      sp1HeliosAddress,
      fromBlock: l2SearchConfig.fromBlock,
      toBlock: l2SearchConfig.toBlock,
    });

    const rawLogs = await paginatedEventQuery(sp1HeliosContract, storageVerifiedFilter, l2SearchConfig);

    // Explicitly cast logs to the correct type
    const events: StorageSlotVerifiedEvent[] = rawLogs.map((log) => ({
      ...log,
      args: log.args as StorageSlotVerifiedEventArgs, // todo: is this a correct type?
    }));

    logger.info({
      at: `Finalizer#heliosL1toL2Finalizer:getL2VerifiedKeys:${l2ChainId}`,
      message: `Found ${events.length} StorageSlotVerified events on L2 (${l2ChainId})`,
    });
    return new Set<string>(events.map((event) => event.args.key));
  } catch (error) {
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:getL2VerifiedKeys:${l2ChainId}`,
      message: `Failed to query StorageSlotVerified events from L2 (${l2ChainId})`,
      sp1HeliosAddress,
      error,
    });
    return null;
  }
}

/** STEP 3: Identify Unfinalized Messages */
function findUnfinalizedMessages(
  logger: winston.Logger,
  relevantStoredCallDataEvents: StoredCallDataEvent[],
  verifiedKeys: Set<string>,
  l2ChainId: number
): StoredCallDataEvent[] {
  const unfinalizedMessages = relevantStoredCallDataEvents.filter((event) => {
    const expectedStorageSlot = calculateHubPoolStoreStorageSlot(event.args);
    return !verifiedKeys.has(expectedStorageSlot);
  });

  logger.info({
    at: `Finalizer#heliosL1toL2Finalizer:findUnfinalizedMessages:${l2ChainId}`,
    message: `Detected ${unfinalizedMessages.length} unfinalized Helios messages after target filtering and verification check.`,
    totalRelevantStoredCallData: relevantStoredCallDataEvents.length,
    totalStorageVerified: verifiedKeys.size,
  });

  return unfinalizedMessages;
}

/** STEP 5: Generate Multicall Data */
async function generateHeliosTxns(
  logger: winston.Logger,
  proofsToSubmit: SuccessfulProof[],
  l1ChainId: number,
  l2ChainId: number,
  l2SpokePoolClient: SpokePoolClient,
  signer: Signer
): Promise<FinalizerPromise> {
  const transactions: AugmentedTransaction[] = [];
  const crossChainMessages: CrossChainMessage[] = [];

  const { address: sp1HeliosAddress, abi: sp1HeliosAbi } = getSp1Helios(l2ChainId);
  if (!sp1HeliosAddress || !sp1HeliosAbi) {
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:generateHeliosMulticallData:${l2ChainId}`,
      message: `SP1Helios contract missing for L2 chain ${l2ChainId} during multicall generation.`,
    });
    return { callData: [], crossChainMessages: [] };
  }
  // Create contract instances with a signer/provider if needed for AugmentedTransaction
  // Assuming l2SpokePoolClient.spokePool has a signer or provider attached
  const sp1HeliosContract = new ethers.Contract(sp1HeliosAddress, sp1HeliosAbi as any, signer);
  const spokePoolContract = l2SpokePoolClient.spokePool; // Get contract instance from client

  for (const proof of proofsToSubmit) {
    try {
      // Ensure the hex strings have the '0x' prefix, adding it only if missing.
      const proofBytes = proof.proofData.proof.startsWith("0x") ? proof.proofData.proof : "0x" + proof.proofData.proof;
      const publicValuesBytes = proof.proofData.public_values.startsWith("0x")
        ? proof.proofData.public_values
        : "0x" + proof.proofData.public_values;

      let decodedOutputs: DecodedProofOutputs;
      try {
        const decodedResult = ethers.utils.defaultAbiCoder.decode([proofOutputsAbiTuple], publicValuesBytes)[0];
        decodedOutputs = {
          executionStateRoot: decodedResult[0],
          newHeader: decodedResult[1],
          nextSyncCommitteeHash: decodedResult[2],
          newHead: decodedResult[3],
          prevHeader: decodedResult[4],
          prevHead: decodedResult[5],
          syncCommitteeHash: decodedResult[6],
          startSyncCommitteeHash: decodedResult[7],
          slots: decodedResult[8].map((slot: any[]) => ({ key: slot[0], value: slot[1], contractAddress: slot[2] })),
        };
      } catch (decodeError) {
        logger.error({
          at: `Finalizer#heliosL1toL2Finalizer:decodePublicValues:${l2ChainId}`,
          message: `Failed to decode public_values for nonce ${proof.sourceNonce.toString()}`,
          publicValues: publicValuesBytes,
          error: decodeError,
        });
        continue;
      }

      // 1. SP1Helios.update transaction
      // todo: Change "0x" to `proofBytes` for production when not using mock verifier
      const updateArgs = ["0x", publicValuesBytes]; // Use actual args
      const updateTx: AugmentedTransaction = {
        contract: sp1HeliosContract,
        chainId: l2ChainId,
        method: "update",
        args: updateArgs,
        unpermissioned: false,
        nonMulticall: true,
        message: `Finalize Helios msg (nonce ${proof.sourceNonce.toString()}) - Step 1: Update SP1Helios`,
      };
      transactions.push(updateTx);
      crossChainMessages.push({
        type: "misc",
        miscReason: "ZK bridge finalization (Helios Update)",
        originationChainId: l1ChainId,
        destinationChainId: l2ChainId,
      });

      logger.debug({
        // Changed from error to debug for this specific log
        message: `SpokePool address for executeMessage: ${spokePoolContract.address}`,
        nonce: proof.sourceNonce.toString(),
      });

      // 2. SpokePool.executeMessage transaction
      // todo: uncomment when we're working with SpokePool that respects the set HubPoolStore address. Otherwise txns will just revert.
      // const executeArgs = [proof.sourceNonce, proof.sourceMessageData, decodedOutputs.newHead];
      // const executeTx: AugmentedTransaction = {
      //   contract: spokePoolContract,
      //   chainId: l2ChainId,
      //   method: "executeMessage",
      //   args: executeArgs,
      //   // todo: check this
      //   unpermissioned: true,
      //   message: `Finalize Helios msg (nonce ${proof.sourceNonce.toString()}) - Step 2: Execute on SpokePool`,
      // };
      // transactions.push(executeTx);
      // crossChainMessages.push({
      //   type: "misc",
      //   miscReason: "ZK bridge finalization (Execute Message)",
      //   originationChainId: l1ChainId,
      //   destinationChainId: l2ChainId,
      // });
    } catch (error) {
      logger.error({
        at: `Finalizer#heliosL1toL2Finalizer:generateTxnItem:${l2ChainId}`, // Renamed log point
        message: `Failed to prepare transaction for proof of nonce ${proof.sourceNonce.toString()}`,
        error: error, // Use stringify helper
        proofData: { sourceNonce: proof.sourceNonce.toString(), target: proof.target }, // Log less data
      });
      continue;
    }
  }

  logger.info({
    at: `Finalizer#heliosL1toL2Finalizer:generateHeliosTxns:${l2ChainId}`,
    message: `Generated ${transactions.length} transactions (${transactions.length / 2} finalizations).`,
    proofNoncesFinalized: proofsToSubmit.map((p) => p.sourceNonce.toString()),
  });

  return { callData: transactions, crossChainMessages: crossChainMessages };
}

// ==================================
// Lower-Level Helper Functions
// ==================================

/**
 * Queries StoredCallData events from the HubPoolStore contract on L1.
 */
async function getL1StoredCallDataEvents(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  l1SpokePoolClient: SpokePoolClient, // Used for block range
  l1ChainId: number,
  l2ChainId: number // For logging context
): Promise<StoredCallDataEvent[] | null> {
  const l1Provider = hubPoolClient.hubPool.provider; // Get provider from HubPoolClient

  const hubPoolStoreInfo = CONTRACT_ADDRESSES[l1ChainId]?.hubPoolStore;
  if (!hubPoolStoreInfo?.address || !hubPoolStoreInfo.abi) {
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:getL1StoredCallDataEvents:${l2ChainId}`,
      message: `HubPoolStore contract address or ABI not found for L1 chain ${l1ChainId}.`,
    });
    return null;
  }

  const hubPoolStoreContract = new ethers.Contract(hubPoolStoreInfo.address, hubPoolStoreInfo.abi as any, l1Provider);

  const l1SearchConfig: EventSearchConfig = {
    fromBlock: l1SpokePoolClient.eventSearchConfig.fromBlock,
    toBlock: l1SpokePoolClient.latestBlockSearched,
    maxBlockLookBack: l1SpokePoolClient.eventSearchConfig.maxBlockLookBack,
  };

  const storedCallDataFilter = hubPoolStoreContract.filters.StoredCallData();

  try {
    logger.debug({
      at: `Finalizer#heliosL1toL2Finalizer:getL1StoredCallDataEvents:${l2ChainId}`,
      message: `Querying StoredCallData events on L1 (${l1ChainId})`,
      hubPoolStoreAddress: hubPoolStoreInfo.address,
      fromBlock: l1SearchConfig.fromBlock,
      toBlock: l1SearchConfig.toBlock,
    });

    const rawLogs = await paginatedEventQuery(hubPoolStoreContract, storedCallDataFilter, l1SearchConfig);

    // Explicitly cast logs to the correct type
    const events: StoredCallDataEvent[] = rawLogs.map((log) => ({
      ...log,
      args: log.args as StoredCallDataEventArgs, // todo: is this type correct?
    }));

    logger.info({
      at: `Finalizer#heliosL1toL2Finalizer:getL1StoredCallDataEvents:${l2ChainId}`,
      message: `Found ${events.length} StoredCallData events on L1 (${l1ChainId})`,
    });
    return events;
  } catch (error) {
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:getL1StoredCallDataEvents:${l2ChainId}`,
      message: `Failed to query StoredCallData events from L1 (${l1ChainId})`,
      hubPoolStoreAddress: hubPoolStoreInfo.address,
      error,
    });
    return null; // Return null on error
  }
}

/**
 * Queries StorageSlotVerified events from the SP1Helios contract on L2.
 */
async function getL2StorageVerifiedEvents(
  logger: winston.Logger,
  l2SpokePoolClient: SpokePoolClient,
  l2ChainId: number
): Promise<StorageSlotVerifiedEvent[] | null> {
  const l2Provider = l2SpokePoolClient.spokePool.provider; // Get provider from L2 client

  const { address: sp1HeliosAddress, abi: sp1HeliosAbi } = getSp1Helios(l2ChainId);
  if (!sp1HeliosAddress || !sp1HeliosAbi) {
    logger.warn({
      at: `Finalizer#heliosL1toL2Finalizer:getL2StorageVerifiedEvents:${l2ChainId}`,
      message: `SP1Helios contract not found for destination chain ${l2ChainId}. Cannot verify Helios messages.`,
    });
    return []; // Return empty array if contract not found, allows finalizer to potentially process other types
  }
  const sp1HeliosContract = new ethers.Contract(sp1HeliosAddress, sp1HeliosAbi as any, l2Provider);

  const l2SearchConfig: EventSearchConfig = {
    fromBlock: l2SpokePoolClient.eventSearchConfig.fromBlock,
    toBlock: l2SpokePoolClient.latestBlockSearched,
    maxBlockLookBack: l2SpokePoolClient.eventSearchConfig.maxBlockLookBack,
  };
  const storageVerifiedFilter = sp1HeliosContract.filters.StorageSlotVerified();

  try {
    logger.debug({
      at: `Finalizer#heliosL1toL2Finalizer:getL2StorageVerifiedEvents:${l2ChainId}`,
      message: `Querying StorageSlotVerified events on L2 (${l2ChainId})`,
      sp1HeliosAddress,
      fromBlock: l2SearchConfig.fromBlock,
      toBlock: l2SearchConfig.toBlock,
    });

    const rawLogs = await paginatedEventQuery(sp1HeliosContract, storageVerifiedFilter, l2SearchConfig);

    // Explicitly cast logs to the correct type
    const events: StorageSlotVerifiedEvent[] = rawLogs.map((log) => ({
      ...log,
      args: log.args as StorageSlotVerifiedEventArgs, // todo: is this a correct type?
    }));

    logger.info({
      at: `Finalizer#heliosL1toL2Finalizer:getL2StorageVerifiedEvents:${l2ChainId}`,
      message: `Found ${events.length} StorageSlotVerified events on L2 (${l2ChainId})`,
    });
    return events;
  } catch (error) {
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:getL2StorageVerifiedEvents:${l2ChainId}`,
      message: `Failed to query StorageSlotVerified events from L2 (${l2ChainId})`,
      sp1HeliosAddress,
      error,
    });
    return null; // Return null on error
  }
}

/**
 * Calculates the storage slot in the HubPoolStore contract for a given nonce.
 * This assumes the data is stored in a mapping at slot 0, keyed by nonce.
 * storage_slot = keccak256(h(k) . h(p)) where k = nonce, p = mapping slot position (0)
 */
// ✅ tested and working
function calculateHubPoolStoreStorageSlot(eventArgs: StoredCallDataEventArgs): string {
  const nonce = eventArgs.nonce;
  const mappingSlotPosition = 0; // The relayMessageCallData mapping is at slot 0

  // Ensure nonce and slot position are correctly padded to 32 bytes (64 hex chars + 0x prefix)
  const paddedNonce = ethers.utils.hexZeroPad(nonce.toHexString(), 32);
  const paddedSlot = ethers.utils.hexZeroPad(ethers.BigNumber.from(mappingSlotPosition).toHexString(), 32);

  // Concatenate the padded key (nonce) and slot position
  // ethers.utils.concat expects Uint8Array or hex string inputs
  const concatenated = ethers.utils.concat([paddedNonce, paddedSlot]);

  // Calculate the Keccak256 hash
  const storageSlot = ethers.utils.keccak256(concatenated);

  return storageSlot;
}

/**
 * Processes unfinalized messages by interacting with the ZK Proof API.
 * Returns a list of successfully retrieved proofs.
 */
async function processUnfinalizedHeliosMessages(
  logger: winston.Logger,
  unfinalizedMessages: StoredCallDataEvent[],
  l2SpokePoolClient: SpokePoolClient,
  l1ChainId: number
): Promise<SuccessfulProof[]> {
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
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:processUnfinalizedHeliosMessages:${l2ChainId}`,
      message: `HubPoolStore contract address not found for L1 chain ${l1ChainId}.`,
    });
    return [];
  }
  const hubPoolStoreAddress = hubPoolStoreInfo.address;
  const { address: sp1HeliosAddress, abi: sp1HeliosAbi } = getSp1Helios(l2ChainId);
  if (!sp1HeliosAddress || !sp1HeliosAbi) {
    logger.warn({
      // Warn because maybe other finalizers can run
      at: `Finalizer#heliosL1toL2Finalizer:processUnfinalizedHeliosMessages:${l2ChainId}`,
      message: `SP1Helios contract not found for L2 chain ${l2ChainId}. Cannot get head/header.`,
    });
    return [];
  }
  const sp1HeliosContract = new ethers.Contract(sp1HeliosAddress, sp1HeliosAbi as any, l2Provider);

  let currentHead: number;
  let currentHeader: string;
  try {
    const headBn: ethers.BigNumber = await sp1HeliosContract.head();
    // todo: well, currently we're taking currentHead to use as prevHead in our ZK proof. There's a particular scenario where we could speed up proofs
    // todo: (by not making them to wait for finality longer than needed) if our blockNumber that we need a proved slot for is older than this head.
    currentHead = headBn.toNumber(); // Convert BigNumber head to number
    currentHeader = await sp1HeliosContract.headers(headBn);
    if (!currentHeader || currentHeader === ethers.constants.HashZero) {
      throw new Error(`Invalid header found for head ${currentHead}`);
    }
    logger.info({
      at: `Finalizer#heliosL1toL2Finalizer:processUnfinalizedHeliosMessages:${l2ChainId}`,
      message: `Using SP1Helios head ${currentHead} and header ${currentHeader} for proof requests.`,
      sp1HeliosAddress,
    });
  } catch (error) {
    logger.error({
      at: `Finalizer#heliosL1toL2Finalizer:processUnfinalizedHeliosMessages:${l2ChainId}`,
      message: `Failed to read current head/header from SP1Helios contract ${sp1HeliosAddress}`,
      error,
    });
    return [];
  }

  const successfulProofs: SuccessfulProof[] = [];

  // todo? Process messages one by one for now, can optimize with Promise.all later
  for (const message of unfinalizedMessages) {
    const logContext = {
      at: `Finalizer#heliosL1toL2Finalizer:processUnfinalizedHeliosMessages:${l2ChainId}`,
      l1TxHash: message.transactionHash,
      nonce: message.args.nonce.toString(),
      target: message.args.target,
    };

    // const storageSlot = calculateHubPoolStoreStorageSlot(message.args);

    // logger.info({
    //   ...logContext,
    //   message: `Calculated this storage slot for stored message with nonce ${message.args.nonce} : ${storageSlot}`,
    // });

    // const apiRequest: ApiProofRequest = {
    //   src_chain_contract_address: hubPoolStoreAddress,
    //   src_chain_storage_slot: storageSlot,
    //   src_chain_block_number: message.blockNumber,
    //   dst_chain_contract_from_head: currentHead,
    //   dst_chain_contract_from_header: currentHeader,
    // };

    // const proofId = calculateProofId(apiRequest);

    // logger.info({
    //   ...logContext,
    //   message: `Args: src_chain_contract_address=${apiRequest.src_chain_contract_address}, src_chain_storage_slot=${apiRequest.src_chain_storage_slot}, src_chain_block_number=${apiRequest.src_chain_block_number}, dst_chain_contract_from_head=${apiRequest.dst_chain_contract_from_head}, dst_chain_contract_from_header=${apiRequest.dst_chain_contract_from_header}, proofId=${proofId}`,
    // });

    // logger.info({
    //   ...logContext,
    //   message: `Calculated this proofId for stored message with nonce ${message.args.nonce} : ${proofId}`,
    // });

    // continue;

    try {
      const storageSlot = calculateHubPoolStoreStorageSlot(message.args);

      const apiRequest: ApiProofRequest = {
        src_chain_contract_address: hubPoolStoreAddress,
        src_chain_storage_slot: storageSlot,
        src_chain_block_number: message.blockNumber,
        dst_chain_contract_from_head: currentHead,
        dst_chain_contract_from_header: currentHeader,
      };

      const proofId = calculateProofId(apiRequest);
      const getProofUrl = `${apiBaseUrl}/api/proofs/${proofId}`;

      logger.debug({ ...logContext, message: "Attempting to get proof", proofId, getProofUrl, storageSlot });

      let proofState: ProofStateResponse | null = null;
      let getError: any = null;

      try {
        const response = await axios.get<ProofStateResponse>(getProofUrl);
        proofState = response.data;
        logger.debug({ ...logContext, message: "Proof state received", proofId, status: proofState.status });
      } catch (error: any) {
        getError = error;
      }

      // --- API Interaction Flow ---

      // 1. Try to get proof
      if (getError && axios.isAxiosError(getError) && getError.response?.status === 404) {
        // 1a. NOTFOUND -> Request proof
        logger.info({ ...logContext, message: "Proof not found (404), requesting...", proofId });
        try {
          const requestProofUrl = `${apiBaseUrl}/api/proofs`;
          await axios.post(requestProofUrl, apiRequest);
          logger.info({ ...logContext, message: "Proof requested successfully.", proofId });
          // Exit flow for this message, will check again next run
        } catch (postError: any) {
          logger.error({
            ...logContext,
            message: "Failed to request proof after 404.",
            proofId,
            postUrl: `${apiBaseUrl}/api/proofs`,
            postError: postError.message,
            postResponseData: postError.response?.data,
          });
          // Exit flow for this message
        }
      } else if (getError) {
        // Other error during GET
        logger.error({
          ...logContext,
          message: "Failed to get proof state.",
          proofId,
          getUrl: getProofUrl,
          getError: getError.message,
          getResponseData: getError.response?.data,
        });
        // Exit flow for this message
      } else if (proofState) {
        // GET successful, check status
        if (proofState.status === "pending") {
          // 1b. SUCCESS ("pending") -> Log and exit flow
          logger.info({ ...logContext, message: "Proof generation is pending.", proofId });
          // Exit flow for this message
        } else if (proofState.status === "errored") {
          // 1c. SUCCESS ("errored") -> Log high severity, request again, exit flow
          logger.error({
            // Use error level log
            ...logContext,
            message: "Proof generation errored. Requesting again.",
            proofId,
            errorMessage: proofState.error_message,
          });
          try {
            const requestProofUrl = `${apiBaseUrl}/api/proofs`;
            await axios.post(requestProofUrl, apiRequest);
            logger.info({ ...logContext, message: "Errored proof requested again successfully.", proofId });
          } catch (postError: any) {
            logger.error({
              ...logContext,
              message: "Failed to re-request errored proof.",
              proofId,
              postUrl: `${apiBaseUrl}/api/proofs`,
              postError: postError.message,
              postResponseData: postError.response?.data,
            });
          }
          // Exit flow for this message
        } else if (proofState.status === "success") {
          // 1d. SUCCESS ("success") -> Collect proof data for later processing
          if (proofState.update_calldata) {
            logger.info({ ...logContext, message: "Proof successfully retrieved.", proofId });
            successfulProofs.push({
              proofData: proofState.update_calldata,
              sourceNonce: message.args.nonce,
              target: message.args.target,
              sourceMessageData: message.args.data,
            });
          } else {
            logger.error({
              ...logContext,
              message: "Proof status is success but update_calldata is missing.",
              proofId,
              proofState,
            });
            // Treat as error, exit flow for this message
          }
        } else {
          logger.error({
            ...logContext,
            message: "Received unexpected proof status.",
            proofId,
            status: proofState.status,
          });
          // Exit flow for this message
        }
      }
      // Implicitly exits flow for the message if none of the success conditions were met
    } catch (processingError) {
      logger.error({
        ...logContext,
        message: "Error processing unfinalized message for proof.",
        error: processingError,
      });
    }
  } // end loop over messages

  return successfulProofs;
}

/**
 * Calculates the deterministic Proof ID based on the request parameters.
 * Matches the Rust implementation using RLP encoding and Keccak256.
 */
// ✅ tested and working
function calculateProofId(request: ApiProofRequest): string {
  const encoded = ethers.utils.RLP.encode([
    request.src_chain_contract_address,
    request.src_chain_storage_slot,
    ethers.BigNumber.from(request.src_chain_block_number).toHexString(), // Ensure block number is hex encoded for RLP
    ethers.BigNumber.from(request.dst_chain_contract_from_head).toHexString(), // Ensure head is hex encoded for RLP
    request.dst_chain_contract_from_header,
  ]);
  return ethers.utils.keccak256(encoded);
}
