import { HubPoolClient, SpokePoolClient, AugmentedTransaction, EVMSpokePoolClient } from "../../clients";
import {
  EventSearchConfig,
  Signer,
  winston,
  paginatedEventQuery,
  compareAddressesSimple,
  ethers,
  BigNumber,
  groupObjectCountsByProp,
  isEVMSpokePoolClient,
  assert,
  Address,
} from "../../utils";
import { spreadEventWithBlockNumber } from "../../utils/EventUtils";
import { FinalizerPromise, CrossChainMessage } from "../types";
import axios from "axios";
import UNIVERSAL_SPOKE_ABI from "../../common/abi/Universal_SpokePool.json";
import { RelayedCallDataEvent, StoredCallDataEvent } from "../../interfaces/Universal";
import { ApiProofRequest, ProofOutputs, ProofStateResponse, SP1HeliosProofData } from "../../interfaces/ZkApi";
import { StorageSlotVerifiedEvent, HeadUpdateEvent } from "../../interfaces/Helios";
import { calculateProofId, decodeProofOutputs } from "../../utils/ZkApiUtils";
import { calculateHubPoolStoreStorageSlot, getHubPoolStoreContract } from "../../utils/UniversalUtils";
import { stringifyThrownValue } from "../../utils/LogUtils";
import { getSp1HeliosContractEVM } from "../../utils/HeliosUtils";
import { getBlockFinder, getBlockForTimestamp } from "../../utils/BlockUtils";

// --- Helios Action Types ---
type HeliosActionType = "UpdateAndExecute" | "ExecuteOnly" | "UpdateOnly";

interface BaseHeliosAction {
  type: HeliosActionType;
}

// Action required to finalize all L1 -> L2 messages
export interface HeliosProofAndExecuteAction extends BaseHeliosAction {
  type: "UpdateAndExecute";
  l1Event: StoredCallDataEvent;
  zkProofData?: SP1HeliosProofData;
}

// Message that completes a previously unfinished finalization of L1 -> L2 message. `Sp1Helios` was updated, but message wasn't executed on `Spoke`
export interface HeliosExecuteOnlyAction extends BaseHeliosAction {
  type: "ExecuteOnly";
  l1Event: StoredCallDataEvent;
  // @dev `head` from `StorageSlotVerified` event on `SP1Helios`. Required for `executeMessage` on `Universal_SpokePool`
  verifiedSlotHead: ethers.BigNumber;
}

// Special KeepAlive message to periodically update `SP1Helios` even if no L1 -> L2 messages are being sent
export interface HeliosKeepAliveAction extends BaseHeliosAction {
  type: "UpdateOnly";
  zkProofData?: SP1HeliosProofData;
}

export type HeliosAction = HeliosProofAndExecuteAction | HeliosExecuteOnlyAction | HeliosKeepAliveAction;
// ---------------------------------------

export async function heliosL1toL2Finalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _senderAddresses: Address[]
): Promise<FinalizerPromise> {
  assert(
    isEVMSpokePoolClient(l2SpokePoolClient) && isEVMSpokePoolClient(l1SpokePoolClient),
    "Cannot use helios finalizer on non-evm chains"
  );
  const l1ChainId = hubPoolClient.chainId;
  const l2ChainId = l2SpokePoolClient.chainId;
  const sp1HeliosL2 = await getSp1HeliosContractEVM(l2SpokePoolClient.spokePool, l2SpokePoolClient.spokePool.signer);
  const { sp1HeliosHead, sp1HeliosHeader } = await getSp1HeliosHeadData(sp1HeliosL2);

  // --- Step 1: Identify all actions needed (pending L1 -> L2 messages to finalize & keep-alive) ---
  const actions = await identifyRequiredActions(
    logger,
    hubPoolClient,
    l1SpokePoolClient,
    l2SpokePoolClient,
    sp1HeliosL2,
    l1ChainId,
    l2ChainId
  );

  logger.debug({
    at: `Finalizer#heliosL1toL2Finalizer:${l2ChainId}`,
    message: `Identified ${actions.length} total Helios actions.`,
    actionCounts: groupObjectCountsByProp(actions, (action) => action.type),
  });

  if (actions.length === 0) {
    return { callData: [], crossChainMessages: [] };
  }

  // --- Step 2: Enrich actions with ZK proofs. Return messages that are ready to submit on-chain ---
  const readyActions = await enrichHeliosActions(
    logger,
    actions,
    l2SpokePoolClient,
    l1SpokePoolClient,
    sp1HeliosHead,
    sp1HeliosHeader
  );

  if (readyActions.length === 0) {
    logger.debug({
      at: `Finalizer#heliosL1toL2Finalizer:${l2ChainId}`,
      message: "No Helios actions are ready for submission after enrichment phase.",
    });
    return { callData: [], crossChainMessages: [] };
  }

  // --- Step 3: Generate transactions from ready-to-submit actions ---
  return generateTxnsForHeliosActions(logger, readyActions, l1ChainId, l2ChainId, l2SpokePoolClient, sp1HeliosL2);
}

// ==================================
// Step-by-step Helper Functions
// ==================================

interface Sp1HeliosHeadData {
  sp1HeliosHead: number;
  sp1HeliosHeader: string;
}

async function getSp1HeliosHeadData(sp1HeliosL2: ethers.Contract): Promise<Sp1HeliosHeadData> {
  const sp1HeliosHeadBn: ethers.BigNumber = await sp1HeliosL2.head();
  const sp1HeliosHead = sp1HeliosHeadBn.toNumber();
  const sp1HeliosHeader = await sp1HeliosL2.headers(sp1HeliosHeadBn);
  if (sp1HeliosHeader === ethers.constants.HashZero) {
    throw new Error(`Zero header found for SP1Helios head ${sp1HeliosHead}. Cannot proceed with proof generation.`);
  }

  return {
    sp1HeliosHead,
    sp1HeliosHeader,
  };
}

async function identifyRequiredActions(
  logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  l1SpokePoolClient: EVMSpokePoolClient,
  l2SpokePoolClient: EVMSpokePoolClient,
  sp1HeliosL2: ethers.Contract,
  l1ChainId: number,
  l2ChainId: number
): Promise<HeliosAction[]> {
  // --- Substep 1: Query and Filter L1 Events (similar to getRelevantL1Events) ---
  const relevantStoredCallDataEvents = await getRelevantL1Events(
    logger,
    hubPoolClient,
    l1SpokePoolClient,
    l1ChainId,
    l2ChainId,
    l2SpokePoolClient.spokePool.address
  );

  // --- Substep 2: Query L2 Verification Events (StorageSlotVerified) ---
  const verifiedSlotsMap = await getL2VerifiedSlotsMap(l2SpokePoolClient, sp1HeliosL2);

  // --- Substep 3: Query L2 Execution Events (RelayedCallData) ---
  const relayedNonces = await getL2RelayedNonces(l2SpokePoolClient);

  const actions: HeliosAction[] = [];

  // --- Determine Status for each L1 Event ---
  for (const l1Event of relevantStoredCallDataEvents) {
    const expectedStorageSlot = calculateHubPoolStoreStorageSlot(l1Event.nonce);
    const nonce = l1Event.nonce;
    const isExecuted = relayedNonces.has(nonce.toString());

    if (isExecuted) {
      // Nothing to do for already executed events
      continue;
    }

    if (verifiedSlotsMap.has(expectedStorageSlot) /* isVerified */) {
      const verifiedEvent = verifiedSlotsMap.get(expectedStorageSlot);
      actions.push({
        type: "ExecuteOnly",
        l1Event: l1Event,
        verifiedSlotHead: verifiedEvent.head,
      });
      // Report half-finished finalization from prev. run
      logger.debug({
        at: `Finalizer#identifyRequiredActions:${l2ChainId}`,
        message:
          "Message requires execution only (already verified in SP1Helios). Will generate SpokePool.executeMessage tx.",
        l1TxRef: l1Event.txnRef,
        nonce: nonce.toString(),
      });
    } else {
      actions.push({
        type: "UpdateAndExecute",
        l1Event: l1Event,
      });
    }
  }

  // --- Substep 4: Check if Keep-Alive action is needed and push to actions if yes ---
  if (await shouldGenerateKeepAliveAction(logger, l2SpokePoolClient, sp1HeliosL2, l2ChainId)) {
    actions.push({
      type: "UpdateOnly",
    });
  }

  logger.debug({
    at: `Finalizer#identifyRequiredActions:${l2ChainId}`,
    message: "Finished identifying Helios actions.",
    totalL1StoredCallData: relevantStoredCallDataEvents.length,
    totalL2VerifiedSlots: verifiedSlotsMap.size,
    totalL2RelayedNonces: relayedNonces.size,
    actionsCount: actions.length,
    actionBreakdown: groupObjectCountsByProp(actions, (action) => action.type),
  });

  return actions;
}

async function shouldGenerateKeepAliveAction(
  logger: winston.Logger,
  l2SpokePoolClient: EVMSpokePoolClient,
  sp1HeliosL2: ethers.Contract,
  l2ChainId: number
): Promise<boolean> {
  const twentyFourHoursInSeconds = 24 * 60 * 60; // 24 hours
  const timestamp24hAgo = Math.floor(Date.now() / 1000) - twentyFourHoursInSeconds;

  const searchConfig: EventSearchConfig = {
    from: l2SpokePoolClient.eventSearchConfig.from,
    to: l2SpokePoolClient.latestHeightSearched,
    maxLookBack: l2SpokePoolClient.eventSearchConfig.maxLookBack,
  };

  const headUpdateFilter = sp1HeliosL2.filters.HeadUpdate();
  const rawHeadUpdateLogs = await paginatedEventQuery(sp1HeliosL2, headUpdateFilter, searchConfig);

  const headUpdateEvents: HeadUpdateEvent[] = rawHeadUpdateLogs.map(
    (log) => spreadEventWithBlockNumber(log) as HeadUpdateEvent
  );

  let latestHeadUpdateBlockNumber = 0;
  for (const event of headUpdateEvents) {
    if (latestHeadUpdateBlockNumber < event.blockNumber) {
      latestHeadUpdateBlockNumber = event.blockNumber;
    }
  }

  const l2BlockFinder = await getBlockFinder(l2ChainId);
  const l2Block24hAgo = await getBlockForTimestamp(l2ChainId, timestamp24hAgo, l2BlockFinder);

  if (latestHeadUpdateBlockNumber < l2Block24hAgo) {
    logger.info({
      at: "Finalizer#shouldGenerateKeepAliveAction",
      message:
        "Latest SP1Helios HeadUpdate event on L2 is older than 24 hours (L2 block time). Should generate keep-alive.",
      latestHeadUpdateBlockNumber,
      l2Block24hAgo,
      l2ChainId,
    });
    return true;
  }
  return false;
}

// returns helios messages ready for on-chain execution enriched with proof data
async function enrichHeliosActions(
  logger: winston.Logger,
  actions: HeliosAction[],
  l2SpokePoolClient: EVMSpokePoolClient,
  l1SpokePoolClient: EVMSpokePoolClient,
  currentL2HeliosHeadNumber: number,
  currentL2HeliosHeader: string
): Promise<HeliosAction[]> {
  const l2ChainId = l2SpokePoolClient.chainId;
  const apiBaseUrl = process.env.HELIOS_PROOF_API_URL;
  if (!apiBaseUrl) {
    throw new Error("[enrichHeliosActions] HELIOS_PROOF_API_URL environment variable not set.");
  }
  const hubPoolStoreAddress = getHubPoolStoreContract(
    l1SpokePoolClient.chainId,
    l1SpokePoolClient.spokePool.provider
  ).address;

  const readyActions: HeliosAction[] = [];
  for (const action of actions) {
    let apiRequest: ApiProofRequest;
    let logContext: any;
    switch (action.type) {
      case "ExecuteOnly":
        // ExecutionOnly messages can be executed right away without a proof, so we add them to `readyActions` and continue
        readyActions.push(action);
        continue;
      case "UpdateAndExecute":
        logContext = {
          at: `Finalizer#heliosL1toL2Finalizer:enrichHeliosActions:${l2ChainId}`,
          messageType: "UpdateAndExecute",
          l1TxHash: action.l1Event.txnRef,
          nonce: action.l1Event.nonce.toString(),
          target: action.l1Event.target,
        };
        apiRequest = {
          src_chain_contract_address: hubPoolStoreAddress,
          src_chain_storage_slots: [calculateHubPoolStoreStorageSlot(action.l1Event.nonce)],
          src_chain_block_number: action.l1Event.blockNumber,
          dst_chain_contract_from_head: currentL2HeliosHeadNumber,
          dst_chain_contract_from_header: currentL2HeliosHeader,
        };
        break;
      case "UpdateOnly":
        logContext = {
          at: `Finalizer#heliosL1toL2Finalizer:enrichHeliosActions:${l2ChainId}`,
          messageType: "UpdateOnly",
        };
        apiRequest = {
          src_chain_contract_address: ethers.constants.AddressZero,
          src_chain_storage_slots: [],
          src_chain_block_number: 0,
          dst_chain_contract_from_head: currentL2HeliosHeadNumber,
          dst_chain_contract_from_header: currentL2HeliosHeader,
        };
        break;
      default: {
        throw new Error(`[enrichHeliosActions] Unhandled action type ${action}`);
      }
    }

    const proofId = calculateProofId(apiRequest);
    const getProofUrl = `${apiBaseUrl}/v1/api/proofs/${proofId}`;

    logger.debug({ ...logContext, message: "Attempting to get proof", proofId, getProofUrl });

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
        await axios.post(`${apiBaseUrl}/v1/api/proofs`, apiRequest);
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
      case "errored": {
        // Proof generation errored on the API side. This is concerning, so we log an error. But nothing to do for us other than to re-request
        // Don't page on 'is not divisible by 32' error. Just warn and log to Slack
        const log =
          proofState.error_message && proofState.error_message.includes("is not divisible by 32")
            ? logger.warn
            : logger.error;
        log({
          ...logContext,
          message: "Proof generation errored on ZK API side. Requesting again.",
          proofId,
          errorMessage: proofState.error_message,
        });

        await axios.post(`${apiBaseUrl}/v1/api/proofs`, apiRequest);
        logger.debug({ ...logContext, message: "Errored proof requested again successfully.", proofId });
        break;
      }
      case "success":
        if (!proofState.update_calldata) {
          throw new Error(`Proof status is success but update_calldata is missing for proofId ${proofId}`);
        }
        logger.debug({ ...logContext, message: "Proof successfully retrieved.", proofId });
        // Proof generation succeeded. Insert `update_calldata` into action. It's now ready to execute
        action.zkProofData = proofState.update_calldata;
        readyActions.push(action);
        break;
      default:
        throw new Error(`Received unexpected proof status for proof ${proofId}`);
    }
    // end loop over actions
  }

  return readyActions;
}

// --- Helper: Query and Filter L1 Events ---
async function getRelevantL1Events(
  _logger: winston.Logger,
  hubPoolClient: HubPoolClient,
  l1SpokePoolClient: EVMSpokePoolClient,
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
  const toBlock = l1SpokePoolClient.latestHeightSearched;
  const fromBlock = Math.floor((l1SpokePoolClient.eventSearchConfig.from + toBlock) / 2);
  const l1SearchConfig: EventSearchConfig = {
    from: fromBlock,
    to: toBlock,
    maxLookBack: l1SpokePoolClient.eventSearchConfig.maxLookBack,
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
  l2SpokePoolClient: EVMSpokePoolClient,
  sp1HeliosL2: ethers.Contract
): Promise<Map<string, StorageSlotVerifiedEvent>> {
  const l2SearchConfig: EventSearchConfig = {
    from: l2SpokePoolClient.eventSearchConfig.from,
    to: l2SpokePoolClient.latestHeightSearched,
    maxLookBack: l2SpokePoolClient.eventSearchConfig.maxLookBack,
  };
  const storageVerifiedFilter = sp1HeliosL2.filters.StorageSlotVerified();
  const rawLogs = await paginatedEventQuery(sp1HeliosL2, storageVerifiedFilter, l2SearchConfig);

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
async function getL2RelayedNonces(l2SpokePoolClient: EVMSpokePoolClient): Promise<Set<string>> {
  const l2Provider = l2SpokePoolClient.spokePool.provider;
  const l2SpokePoolAddress = l2SpokePoolClient.spokePool.address;
  const universalSpokePoolContract = new ethers.Contract(l2SpokePoolAddress, UNIVERSAL_SPOKE_ABI, l2Provider);

  const l2SearchConfig: EventSearchConfig = {
    from: l2SpokePoolClient.eventSearchConfig.from,
    to: l2SpokePoolClient.latestHeightSearched,
    maxLookBack: l2SpokePoolClient.eventSearchConfig.maxLookBack,
  };
  const relayedCallDataFilter = universalSpokePoolContract.filters.RelayedCallData();

  const rawLogs = await paginatedEventQuery(universalSpokePoolContract, relayedCallDataFilter, l2SearchConfig);

  // Use spreadEventWithBlockNumber and cast to the flattened type
  const events: RelayedCallDataEvent[] = rawLogs.map((log) => spreadEventWithBlockNumber(log) as RelayedCallDataEvent);

  // Return a Set of nonces (as strings for easy comparison)
  return new Set<string>(events.map((event) => event.nonce.toString()));
}

// Helper type for the summary structure
type ActionTypeSummary = {
  count: number;
  nonces?: string[]; // Only for types that have nonces
};

type HeliosActionsSummary = {
  UpdateAndExecute: Required<ActionTypeSummary>; // nonces are always present
  ExecuteOnly: Required<ActionTypeSummary>; // nonces are always present
  UpdateOnly: { count: number };
};

function logSummary(logger: winston.Logger, readyActions: HeliosAction[], l2ChainId: number) {
  const initialSummary: HeliosActionsSummary = {
    UpdateAndExecute: { count: 0, nonces: [] },
    ExecuteOnly: { count: 0, nonces: [] },
    UpdateOnly: { count: 0 },
  };

  const summary = readyActions.reduce((acc, action) => {
    switch (action.type) {
      case "UpdateAndExecute":
        acc.UpdateAndExecute.count++;
        acc.UpdateAndExecute.nonces.push(action.l1Event.nonce.toString());
        break;
      case "ExecuteOnly":
        acc.ExecuteOnly.count++;
        acc.ExecuteOnly.nonces.push(action.l1Event.nonce.toString());
        break;
      case "UpdateOnly":
        acc.UpdateOnly.count++;
        break;
      default:
        throw new Error(`[logSummary] Unknown action type ${action}`);
    }
    return acc;
  }, initialSummary);

  logger.debug({
    at: `Finalizer#logSummary:${l2ChainId}`,
    message: `Summary of ${readyActions.length} ready Helios actions.`,
    summary,
  });
}

/** --- Generate Multicall Data --- */
async function generateTxnsForHeliosActions(
  logger: winston.Logger,
  readyActions: HeliosAction[],
  l1ChainId: number,
  l2ChainId: number,
  l2SpokePoolClient: EVMSpokePoolClient,
  sp1HeliosL2: ethers.Contract
): Promise<FinalizerPromise> {
  const transactions: AugmentedTransaction[] = [];
  const crossChainMessages: CrossChainMessage[] = [];

  const universalSpokePoolContract = new ethers.Contract(
    l2SpokePoolClient.spokePool.address,
    [...UNIVERSAL_SPOKE_ABI],
    l2SpokePoolClient.spokePool.signer
  );

  for (const action of readyActions) {
    switch (action.type) {
      case "ExecuteOnly":
        addExecuteOnlyTxn(
          logger,
          l1ChainId,
          l2ChainId,
          transactions,
          crossChainMessages,
          universalSpokePoolContract,
          action
        );
        break;

      case "UpdateAndExecute":
        addUpdateAndExecuteTxns(
          l1ChainId,
          l2ChainId,
          transactions,
          crossChainMessages,
          sp1HeliosL2,
          universalSpokePoolContract,
          action
        );
        break;

      case "UpdateOnly":
        addUpdateOnlyTxn(l1ChainId, l2ChainId, transactions, crossChainMessages, sp1HeliosL2, action);
        break;

      default:
        throw new Error(`[generateTxnsForHeliosActions] unhandled action type ${action}`);
    }
  }

  logSummary(logger, readyActions, l2ChainId);

  return { callData: transactions, crossChainMessages: crossChainMessages };
}

function addExecuteOnlyTxn(
  logger: winston.Logger,
  l1ChainId: number,
  l2ChainId: number,
  transactions: AugmentedTransaction[],
  crossChainMessages: CrossChainMessage[],
  universalSpokePoolContract: ethers.Contract,
  action: HeliosExecuteOnlyAction
) {
  const { l1Event, verifiedSlotHead } = action;

  if (!verifiedSlotHead) {
    throw new Error("Logic error: verifiedSlotHead missing from HeliosExecuteOnlyAction");
  }

  logger.warn({
    at: `Finalizer#addExecuteOnlyTxn:${l2ChainId}`,
    message: "Generating SpokePool.executeMessage ONLY for partially finalized message.",
    nonce: l1Event.nonce.toString(),
    l1TxHash: l1Event.txnRef,
    verifiedHead: verifiedSlotHead.toString(),
  });

  const encodedMessage = ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [l1Event.target, l1Event.data]);
  const executeArgs = [l1Event.nonce, encodedMessage, verifiedSlotHead];
  const executeTx: AugmentedTransaction = {
    contract: universalSpokePoolContract,
    chainId: l2ChainId,
    method: "executeMessage",
    args: executeArgs,
    unpermissioned: true,
    canFailInSimulation: false,
    message: `Finalize Helios msg (HubPoolStore nonce ${action.l1Event.nonce.toString()}) - Step 2 ONLY: Execute on SpokePool`,
  };
  transactions.push(executeTx);
  crossChainMessages.push({
    type: "misc",
    miscReason: "ZK bridge finalization (Execute Message Only)",
    originationChainId: l1ChainId,
    destinationChainId: l2ChainId,
  });
}

function addUpdateAndExecuteTxns(
  l1ChainId: number,
  l2ChainId: number,
  transactions: AugmentedTransaction[],
  crossChainMessages: CrossChainMessage[],
  sp1HeliosContract: ethers.Contract,
  universalSpokePoolContract: ethers.Contract,
  action: HeliosProofAndExecuteAction
) {
  const { l1Event, zkProofData } = action;

  if (!zkProofData) {
    throw new Error(
      "[updateTxnArraysProofAndExecution] Logic error: zkProofData missing from HeliosProofAndExecuteAction"
    );
  }

  // Ensure the hex strings have the '0x' prefix, adding it only if missing.
  const proofBytes = zkProofData.proof.startsWith("0x") ? zkProofData.proof : "0x" + zkProofData.proof;
  const publicValuesBytes = zkProofData.public_values.startsWith("0x")
    ? zkProofData.public_values
    : "0x" + zkProofData.public_values;

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
    message: `Finalize Helios msg (HubPoolStore nonce ${l1Event.nonce.toString()}) - Step 1: Update SP1Helios`,
  };
  transactions.push(updateTx);
  crossChainMessages.push({
    type: "misc",
    miscReason: "ZK bridge finalization (Helios Update)",
    originationChainId: l1ChainId,
    destinationChainId: l2ChainId,
  });

  // 2. SpokePool.executeMessage transaction
  const encodedMessage = ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [l1Event.target, l1Event.data]);
  const executeArgs = [l1Event.nonce, encodedMessage, decodedOutputs.newHead];
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
    message: `Finalize Helios msg (HubPoolStore nonce ${l1Event.nonce.toString()}) - Step 2: Execute on SpokePool`,
  };
  transactions.push(executeTx);
  crossChainMessages.push({
    type: "misc",
    miscReason: "ZK bridge finalization (Execute Message)",
    originationChainId: l1ChainId,
    destinationChainId: l2ChainId,
  });
}

function addUpdateOnlyTxn(
  l1ChainId: number,
  l2ChainId: number,
  transactions: AugmentedTransaction[],
  crossChainMessages: CrossChainMessage[],
  sp1HeliosContract: ethers.Contract,
  action: HeliosKeepAliveAction
) {
  const { zkProofData } = action;

  if (!zkProofData) {
    throw new Error("[updateTxnArraysKeepAlive] Logic error: zkProofData missing from HeliosKeepAliveAction");
  }

  // Ensure the hex strings have the '0x' prefix, adding it only if missing.
  const proofBytes = zkProofData.proof.startsWith("0x") ? zkProofData.proof : "0x" + zkProofData.proof;
  const publicValuesBytes = zkProofData.public_values.startsWith("0x")
    ? zkProofData.public_values
    : "0x" + zkProofData.public_values;

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
    message: `KeepAlive msg for SP1Helios: updating to a newer head ${decodedOutputs.prevHead} -> ${decodedOutputs.newHead}`,
  };
  transactions.push(updateTx);
  crossChainMessages.push({
    type: "misc",
    miscReason: "ZK bridge finalization (Helios Update)",
    originationChainId: l1ChainId,
    destinationChainId: l2ChainId,
  });
}
