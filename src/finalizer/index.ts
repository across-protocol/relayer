import { CCTP_NO_DOMAIN, ChainFamily, PRODUCTION_NETWORKS } from "@across-protocol/constants";
import { utils as sdkUtils } from "@across-protocol/sdk";
import assert from "assert";
import { Contract, utils as ethersUtils } from "ethers";
import {
  AugmentedTransaction,
  HubPoolClient,
  isKnownRevertReason,
  knownRevertReasons,
  MultiCallerClient,
} from "../clients";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithLookback,
  getContractEntry,
  updateSpokePoolClients,
  UNIVERSAL_CHAINS,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import {
  Signer,
  blockExplorerLink,
  config as dotenvConfig,
  disconnectRedisClients,
  getMultisender,
  getNetworkName,
  Multicall2Call,
  processEndPollingLoop,
  startupLogLevel,
  winston,
  CHAIN_IDs,
  Profiler,
  stringifyThrownValue,
  chainIsEvm,
  EvmAddress,
  getProvider,
  chunk,
  isPromiseFulfilled,
} from "../utils";
import { ChainFinalizer, CrossChainMessage, Finalizer, isAugmentedTransaction } from "./types";
import {
  arbStackFinalizer,
  binanceFinalizer,
  cctpV1L1toSvmL2Finalizer,
  cctpV1SvmL2toL1Finalizer,
  cctpV2Finalizer,
  heliosL1toL2Finalizer,
  lineaL1ToL2Finalizer,
  lineaL2ToL1Finalizer,
  opStackFinalizer,
  polygonFinalizer,
  zkSyncFinalizer,
  oftRetryFinalizer,
} from "./utils";
import { FinalizerConfig } from "./config";

const { isDefined } = sdkUtils;

dotenvConfig();
let logger: winston.Logger;

/**
 * A list of finalizers that can be used to finalize messages on a chain.
 * The pre-populated entries are exceptions to what is autogeneated by generateChainConfig() below.
 */
const chainFinalizers: {
  [chainId: number]: { finalizeOnL2?: ChainFinalizer[]; finalizeOnL1?: ChainFinalizer[]; finalizeOnAny?: Finalizer[] };
} = {
  // Mainnets
  [CHAIN_IDs.POLYGON]: {
    finalizeOnL1: [polygonFinalizer],
  },
  [CHAIN_IDs.ZK_SYNC]: {
    finalizeOnL1: [zkSyncFinalizer],
  },
  [CHAIN_IDs.ARBITRUM]: {
    finalizeOnL1: [arbStackFinalizer],
  },
  [CHAIN_IDs.LINEA]: {
    finalizeOnL1: [lineaL2ToL1Finalizer],
    finalizeOnL2: [lineaL1ToL2Finalizer],
  },
  [CHAIN_IDs.BSC]: {
    finalizeOnL1: [binanceFinalizer],
  },
  // Testnets
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: {
    finalizeOnL1: [arbStackFinalizer],
  },
  [CHAIN_IDs.POLYGON_AMOY]: {
    finalizeOnL1: [polygonFinalizer],
  },
  [CHAIN_IDs.SOLANA]: {
    finalizeOnL1: [cctpV1L1toSvmL2Finalizer],
    finalizeOnL2: [cctpV1SvmL2toL1Finalizer],
  },
};

/**
 * Autopopulate the majority of the chainFinalizers object above.
 * @returns void
 */
function generateChainConfig(): void {
  const erc20Defaults: Partial<Record<ChainFamily, ChainFinalizer>> = {
    [ChainFamily.OP_STACK]: opStackFinalizer,
    [ChainFamily.ORBIT]: arbStackFinalizer,
    [ChainFamily.ZK_STACK]: zkSyncFinalizer,
  };

  Object.entries(PRODUCTION_NETWORKS).forEach(([_chainId, { cctpDomain, family }]) => {
    const chainId = Number(_chainId);
    const config = (chainFinalizers[chainId] ??= {});
    config.finalizeOnL1 ??= [];
    config.finalizeOnL2 ??= [];
    config.finalizeOnAny ??= [];

    const l1Finalizer = erc20Defaults[family];
    if (isDefined(l1Finalizer)) {
      config.finalizeOnL1.push(l1Finalizer);
    }

    if (UNIVERSAL_CHAINS.includes(chainId)) {
      config.finalizeOnL2.push(heliosL1toL2Finalizer);
    }

    // Autoconfigure CCTP finalisation. SVM is currently limited to v1.
    if (cctpDomain !== CCTP_NO_DOMAIN && family !== ChainFamily.SVM) {
      config.finalizeOnAny.push(cctpV2Finalizer);
    }

    // @todo Once contracts are linked, change this to add all chains w/ OFT enabled.
    if (chainId === CHAIN_IDs.ARBITRUM) {
      config.finalizeOnAny.push(oftRetryFinalizer);
    }
  });
}

type ExcludedFinalization = {
  crossChainMessage: CrossChainMessage;
  // A race with another finalizer resolves itself; anything else wants an operator to look at it.
  benign: boolean;
  summary: object;
};

const ERROR_STRING_SELECTOR = "0x08c379a0"; // Error(string)

// A finalization target's ABI isn't known here, so a custom error can only be recognised by its selector.
// Cover the no-argument ones we already treat as benign, so that a race reported as `ClaimedMerkleLeaf()`
// rather than as a string is still identifiable.
const KNOWN_ERROR_SELECTORS: { [selector: string]: string } = Object.fromEntries(
  [...knownRevertReasons]
    .filter((reason) => /^[A-Za-z_]\w*$/.test(reason))
    .map((reason) => [ethersUtils.id(`${reason}()`).slice(0, 10), reason])
);

/**
 * Multicall3 hands back the raw revert payload of a failed call. Decode the standard Error(string) case and
 * the custom errors we recognise; anything else can only be reported verbatim.
 */
function decodeRevertReason(returnData?: string): string | undefined {
  if (!isDefined(returnData) || returnData === "0x") {
    return undefined;
  }
  if (returnData.startsWith(ERROR_STRING_SELECTOR)) {
    try {
      return ethersUtils.defaultAbiCoder.decode(["string"], `0x${returnData.slice(10)}`)[0] as string;
    } catch {
      // Not an Error(string) after all; fall through and report the payload as-is.
    }
  }
  return KNOWN_ERROR_SELECTORS[returnData.slice(0, 10)] ?? returnData;
}

/**
 * Simulate each finalization on its own before batching it.
 *
 * Multicall3 discards the revert reason of a failing call -- a batch surfaces only "Multicall3: call
 * failed" -- so one bad finalization used to silently block every other finalization bound for the same
 * chain, indefinitely, with nothing in the logs to say which one was at fault. Simulating each call
 * individually names the culprit and lets us drop just that call.
 *
 * @dev The simulation runs through the multisender's tryAggregate() rather than as a plain eth_call from
 * the EOA, because that is how the call executes in production: msg.sender is Multicall3, and some
 * targets key off it (the legacy OptimismPortal matches a withdrawal against its proof submitter, which
 * is Multicall3 whenever this bot submitted the proof). An EOA-sender simulation would reject those.
 * tryAggregate also reports the inner revert reason, which aggregate() would have thrown away.
 * @dev Submission uses tryAggregate(requireSuccess=false), so a reverting call can no longer take the
 * batch down with it. That makes this pre-flight advisory: a call we could not simulate at all (RPC
 * failure) is submitted anyway rather than dropped on no evidence.
 * @returns The calls to submit, and the messages excluded from them.
 */
export async function preflightFinalizations(
  logger: winston.Logger,
  chainId: number,
  multisender: Contract,
  from: string,
  finalizations: { txn: Multicall2Call; crossChainMessage: CrossChainMessage }[]
): Promise<{ callsToSubmit: Multicall2Call[]; excluded: ExcludedFinalization[] }> {
  const network = getNetworkName(chainId);
  const results = await Promise.allSettled(
    finalizations.map(({ txn }) => multisender.callStatic.tryAggregate(false, [txn], { from }))
  );

  const summarise = (
    { txn, crossChainMessage }: { txn: Multicall2Call; crossChainMessage: CrossChainMessage },
    reason?: string,
    revertData?: string
  ) => {
    const { originationChainId, destinationChainId, type } = crossChainMessage;
    return {
      originationChain: getNetworkName(originationChainId),
      destinationChain: getNetworkName(destinationChainId),
      type,
      amount: "amount" in crossChainMessage ? crossChainMessage.amount : undefined,
      l1TokenSymbol: "l1TokenSymbol" in crossChainMessage ? crossChainMessage.l1TokenSymbol : undefined,
      target: txn.target,
      revertData,
      reason,
    };
  };

  const callsToSubmit: Multicall2Call[] = [];
  const excluded: ExcludedFinalization[] = [];
  const unverified: object[] = [];
  results.forEach((result, idx) => {
    const finalization = finalizations[idx];
    const { txn, crossChainMessage } = finalization;

    if (!isPromiseFulfilled(result)) {
      unverified.push(summarise(finalization, stringifyThrownValue(result.reason)));
      callsToSubmit.push(txn);
      return;
    }

    // tryAggregate returns one Result per call; anything else leaves us without a verdict to act on.
    const [callResult] = (result.value ?? []) as { success: boolean; returnData: string }[];
    if (!isDefined(callResult)) {
      unverified.push(summarise(finalization, "pre-flight returned no result"));
      callsToSubmit.push(txn);
      return;
    }

    const { success, returnData } = callResult;
    if (success) {
      callsToSubmit.push(txn);
      return;
    }

    const reason = decodeRevertReason(returnData);
    excluded.push({
      crossChainMessage,
      benign: isKnownRevertReason(reason),
      summary: summarise(finalization, reason, returnData),
    });
  });

  // A message another finalizer has already claimed is expected and needs no attention.
  const races = excluded.filter(({ benign }) => benign);
  if (races.length > 0) {
    logger.debug({
      at: "Finalizer#preflightFinalizations",
      message: `Excluded ${races.length} already-finalized message(s) from the ${network} batch.`,
      races: races.map(({ summary }) => summary),
    });
  }

  const reverted = excluded.filter(({ benign }) => !benign);
  if (reverted.length > 0) {
    logger.error({
      at: "Finalizer#preflightFinalizations",
      message: `Excluded ${reverted.length} reverting finalization(s) from the ${network} batch 🚨`,
      notificationPath: "across-error",
      reverted: reverted.map(({ summary }) => summary),
    });
  }

  if (unverified.length > 0) {
    logger.warn({
      at: "Finalizer#preflightFinalizations",
      message: `Could not pre-flight ${unverified.length} ${network} finalization(s); submitting them regardless.`,
      unverified,
    });
  }

  return { callsToSubmit, excluded };
}

export async function finalize(
  logger: winston.Logger,
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  config: FinalizerConfig
): Promise<void> {
  const hubChainId = hubPoolClient.chainId;

  const {
    chainsToFinalize: configuredChainIds,
    finalizationStrategy,
    sendingTransactionsEnabled: submitFinalizationTransactions,
  } = config;

  generateChainConfig();

  // Note: Could move this into a client in the future to manage # of calls and chunk calls based on
  // input byte length.
  const finalizations: { txn: Multicall2Call | AugmentedTransaction; crossChainMessage: CrossChainMessage }[] = [];

  // For each chain, delegate to a handler to look up any TokensBridged events and attempt finalization.
  for (const chainIdBatch of chunk(configuredChainIds, config.chunkSize)) {
    await sdkUtils.mapAsync(chainIdBatch, async (chainId) => {
      const client = spokePoolClients[chainId];
      if (client === undefined) {
        logger.warn({
          at: "Finalizer",
          message: `Skipping finalizations for ${getNetworkName(
            chainId
          )} because spoke pool client does not exist, is it disabled?`,
          configuredChainIds,
          availableChainIds: Object.keys(spokePoolClients),
        });
        return;
      }

      // We should only finalize the direction that has been specified in
      // the finalization strategy.
      const chainFinalizer = chainFinalizers[chainId];
      if (chainFinalizer === undefined) {
        logger.warn({
          at: "Finalizer",
          message: `No finalizer configured for ${getNetworkName(chainId)}, skipping.`,
        });
        return;
      }
      const { finalizeOnL1 = [], finalizeOnL2 = [], finalizeOnAny = [] } = chainFinalizer;
      const chainSpecificFinalizers: { genericFinalizer: boolean; finalizer: ChainFinalizer | Finalizer }[] = [];
      switch (finalizationStrategy) {
        case "l1->l2":
          chainSpecificFinalizers.push(...finalizeOnL2.map((finalizer) => ({ finalizer, genericFinalizer: false })));
          break;
        case "l2->l1":
          chainSpecificFinalizers.push(...finalizeOnL1.map((finalizer) => ({ finalizer, genericFinalizer: false })));
          break;
        case "any<->any":
          chainSpecificFinalizers.push(...finalizeOnAny.map((finalizer) => ({ finalizer, genericFinalizer: true })));
          break;
        case "l1<->l2":
          chainSpecificFinalizers.push(
            ...finalizeOnL1.map((finalizer) => ({ finalizer, genericFinalizer: false })),
            ...finalizeOnL2.map((finalizer) => ({ finalizer, genericFinalizer: false }))
          );
          break;
      }
      assert(chainSpecificFinalizers?.length > 0, `No finalizer available for chain ${chainId}`);

      const network = getNetworkName(chainId);

      // Some finalizer adapters query TokensBridged events on the L2 spoke pools to discover withdrawals that
      // need to be finalized and will ignore the following address list. For others, this list comprises both the
      // "sender" and "recipient" addresses we should look out for. Some bridging events don't let us query for the sender
      // or the recipient so its important to track for both, even if that means more RPC requests.
      // Always track HubPool, SpokePool, AtomicDepositor. HubPool sends messages and
      // tokens to the SpokePool, while the relayer rebalances ETH via the AtomicDepositor.
      const addressesToFinalize = new Map(config.userAddresses);
      addressesToFinalize.set(EvmAddress.from(hubPoolClient.hubPool.address), []);
      addressesToFinalize.set(EvmAddress.from(getContractEntry(hubChainId, "atomicDepositor").address), []);
      assert(isDefined(client.spokePoolAddress), `${getNetworkName(chainId)} spoke pool address not yet known`);
      addressesToFinalize.set(client.spokePoolAddress, []);

      // We can subloop through the finalizers for each chain, and then execute the finalizer. For now, the
      // main reason for this is related to CCTP finalizations. We want to run the CCTP finalizer AND the
      // normal finalizer for each chain. This is going to cause an overlap of finalization attempts on USDC.
      // However, that's okay because each finalizer will only attempt to finalize the messages that it is
      // responsible for.
      let totalWithdrawalsForChain = 0;
      let totalDepositsForChain = 0;
      let totalMiscTxnsForChain = 0;
      const isChainSpecificFinalizer = (
        finalizer: ChainFinalizer | Finalizer,
        genericFinalizer: boolean
      ): finalizer is ChainFinalizer => {
        return !genericFinalizer;
      };
      await sdkUtils.mapAsync(chainSpecificFinalizers, async ({ finalizer, genericFinalizer }) => {
        try {
          let callData: (Multicall2Call | AugmentedTransaction)[], crossChainMessages: CrossChainMessage[];
          if (isChainSpecificFinalizer(finalizer, genericFinalizer)) {
            ({ callData, crossChainMessages } = await finalizer(
              logger,
              hubSigner,
              hubPoolClient,
              client,
              spokePoolClients[hubChainId],
              addressesToFinalize
            ));
          } else {
            ({ callData, crossChainMessages } = await finalizer(logger, client, addressesToFinalize));
          }

          callData.forEach((txn, idx) => {
            const crossChainMessage = crossChainMessages[idx];
            assert(isDefined(crossChainMessage), `Missing crossChainMessage for ${network} txn ${idx}`);
            finalizations.push({ txn, crossChainMessage });
          });

          totalWithdrawalsForChain += crossChainMessages.filter(({ type }) => type === "withdrawal").length;
          totalDepositsForChain += crossChainMessages.filter(({ type }) => type === "deposit").length;
          totalMiscTxnsForChain += crossChainMessages.filter(({ type }) => type === "misc").length;
        } catch (_e) {
          logger.error({
            at: "finalizer",
            message: `Something errored in a finalizer for chain ${client.chainId}`,
            error: stringifyThrownValue(_e),
          });
        }
      });
      const totalTransfers = totalWithdrawalsForChain + totalDepositsForChain + totalMiscTxnsForChain;
      logger.debug({
        at: "finalize",
        message: `Found ${totalTransfers} ${network} messages (${totalWithdrawalsForChain} withdrawals | ${totalDepositsForChain} deposits | ${totalMiscTxnsForChain} misc txns) for finalization.`,
      });
    });
  }
  const multicall2Lookup = Object.fromEntries(
    await Promise.all(
      finalizations
        .map(({ crossChainMessage }) => crossChainMessage.destinationChainId)
        .filter(chainIsEvm)
        .map(async (chainId) => {
          const signer = hubSigner.connect(await getProvider(chainId));
          return [chainId, getMultisender(chainId, signer)] as [number, Contract];
        })
    )
  );
  // Assert that no multicall2Lookup is undefined
  assert(
    Object.values(multicall2Lookup).every(isDefined),
    `Multicall2 lookup is undefined for chain ids: ${Object.entries(multicall2Lookup)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k)}`
  );

  if (finalizations.length > 0) {
    // @dev use multicaller client to execute batched txn to take advantage of its native txn simulation
    // safety features. This only works because we assume all finalizer transactions are
    // unpermissioned (i.e. msg.sender can be anyone). If this is not true for any chain then we'd need to use
    // the TransactionClient.
    const multicallerClient = new MultiCallerClient(logger);
    let txnRefLookup: Record<number, string[]> = {};
    // Messages dropped in pre-flight, so that the per-message logs below don't report them as finalized.
    const excludedMessages = new Map<CrossChainMessage, ExcludedFinalization>();
    try {
      const finalizationsByChain = Object.groupBy(
        finalizations,
        ({ crossChainMessage }) => crossChainMessage.destinationChainId
      );

      // @dev Here, we enqueueTransaction individual transactions right away, and we batch all multicalls into `multicallTxns` to enqueue as a single tx right after
      const hubSignerAddress = await hubSigner.getAddress();
      for (const [chainId, finalizations] of Object.entries(finalizationsByChain)) {
        const multicallFinalizations: { txn: Multicall2Call; crossChainMessage: CrossChainMessage }[] = [];

        finalizations?.forEach(({ txn, crossChainMessage }) => {
          if (isAugmentedTransaction(txn)) {
            // It's an AugmentedTransaction, enqueue directly
            txn.nonMulticall = true; // cautiously enforce an invariant that should already be present
            multicallerClient.enqueueTransaction(txn);
          } else {
            // It's a Multicall2Call, collect for batching
            multicallFinalizations.push({ txn, crossChainMessage });
          }
        });

        if (multicallFinalizations.length > 0) {
          const multisender = multicall2Lookup[Number(chainId)];
          const { callsToSubmit: multicallTxns, excluded } = await preflightFinalizations(
            logger,
            Number(chainId),
            multisender,
            hubSignerAddress,
            multicallFinalizations
          );
          excluded.forEach((exclusion) => excludedMessages.set(exclusion.crossChainMessage, exclusion));
          if (multicallTxns.length > 0) {
            const txnToSubmit: AugmentedTransaction = {
              contract: multisender,
              chainId: Number(chainId),
              // @dev tryAggregate(requireSuccess=false) rather than aggregate(): a call that starts
              // reverting between the pre-flight above and inclusion must not take the whole batch --
              // and with it every other pending finalization -- down with it.
              method: "tryAggregate",
              args: [false, multicallTxns],
              unpermissioned: true,
              message: `Batch finalized ${multicallTxns.length} txns`,
              mrkdwn: `Batch finalized ${multicallTxns.length} txns`,
            };
            multicallerClient.enqueueTransaction(txnToSubmit);
          }
        }
      }
      txnRefLookup = await multicallerClient.executeTxnQueues(!submitFinalizationTransactions);
    } catch (_error) {
      const error = _error as Error;
      logger.warn({
        at: "Finalizer",
        message: "Error creating aggregateTx",
        reason: error.stack || error.message || error.toString(),
        notificationPath: "across-error",
        finalizations,
      });
      return;
    }

    const { transfers = [], misc = [] } = Object.groupBy(
      finalizations.filter(({ crossChainMessage }) => isDefined(crossChainMessage)),
      ({ crossChainMessage: { type } }) => {
        return type === "misc" ? "misc" : "transfers";
      }
    );

    // @dev These log lines are derived from crossChainMessages, not from what actually landed on chain, so
    // on their own they will happily report "Finalized ..." for a message that was dropped in pre-flight or
    // that belongs to a batch which was never submitted. Report those honestly and at warn level, otherwise
    // a stalled finalizer reads as a healthy one. Suppressed when not submitting transactions, where an
    // empty txnRefList is expected.
    const submissionStatus = (crossChainMessage: CrossChainMessage) => {
      const { destinationChainId } = crossChainMessage;
      const exclusion = excludedMessages.get(crossChainMessage);
      if (isDefined(exclusion)) {
        return {
          submitted: false,
          level: "warn" as const,
          details: {
            unsubmitted: `excluded from the ${getNetworkName(destinationChainId)} batch: reverted in pre-flight ⚠️`,
            // A race with another finalizer resolves itself; anything else wants an operator.
            ...(exclusion.benign ? {} : { notificationPath: "across-error" }),
          },
        };
      }
      if (!submitFinalizationTransactions || txnRefLookup[destinationChainId]?.length > 0) {
        return { submitted: true, level: "info" as const, details: {} };
      }
      return {
        submitted: false,
        level: "warn" as const,
        details: { notificationPath: "across-error", unsubmitted: "no transaction was submitted for this message ⚠️" },
      };
    };

    misc.forEach(({ crossChainMessage }) => {
      const { originationChainId, destinationChainId, amount, l1TokenSymbol: symbol, type } = crossChainMessage;
      // Required for tsc to be happy.
      if (type !== "misc") {
        return;
      }
      const { miscReason } = crossChainMessage;
      const originationNetwork = getNetworkName(originationChainId);
      const destinationNetwork = getNetworkName(destinationChainId);
      const infoLogMessage =
        amount && symbol ? `to support a ${originationNetwork} withdrawal of ${amount} ${symbol} 🔜` : "";
      const { submitted, level, details } = submissionStatus(crossChainMessage);
      logger[level]({
        at: "Finalizer",
        message: `${submitted ? "Submitted" : "Did not submit"} ${miscReason} on ${destinationNetwork}`,
        infoLogMessage,
        txnRefList: txnRefLookup[destinationChainId]?.map((txnRef) => blockExplorerLink(txnRef, destinationChainId)),
        ...details,
      });
    });
    transfers.forEach(({ crossChainMessage }) => {
      const { originationChainId, destinationChainId, type, amount, l1TokenSymbol: symbol } = crossChainMessage;
      const originationNetwork = getNetworkName(originationChainId);
      const destinationNetwork = getNetworkName(destinationChainId);
      const { submitted, level, details } = submissionStatus(crossChainMessage);
      logger[level]({
        at: "Finalizer",
        message: `${
          submitted ? "Finalized" : "Did not finalize"
        } ${originationNetwork} ${type} on ${destinationNetwork} for ${amount} ${symbol} ${submitted ? "🪃" : "⚠️"}`,
        txnRefList: txnRefLookup[destinationChainId]?.map((txnRef) => blockExplorerLink(txnRef, destinationChainId)),
        ...details,
      });
    });
  }
}

export async function constructFinalizerClients(
  _logger: winston.Logger,
  config: FinalizerConfig,
  baseSigner: Signer
): Promise<{
  commonClients: Clients;
  spokePoolClients: SpokePoolClientsByChain;
}> {
  // The finalizer only uses the HubPoolClient to look up the *latest* l1 tokens matching an l2 token that was
  // withdrawn to L1, so assuming these L1 tokens do not change in the future, then we can reduce the hub pool
  // client lookback. Note, this should not be impacted by L2 tokens changing, for example when changing
  // USDC.e --> USDC because the l1 token matching both L2 version stays the same.
  const hubPoolLookBack = config.maxFinalizerLookback + 8 * 3600;
  const commonClients = await constructClients(_logger, config, baseSigner, hubPoolLookBack);
  await updateFinalizerClients(commonClients);

  if (config.chainsToFinalize.length === 0) {
    config.chainsToFinalize = commonClients.configStoreClient.getChainIdIndicesForBlock();
  }

  config.validate(config.chainsToFinalize, _logger);

  // Make sure we have at least one chain to finalize and that we include the mainnet chain if it's not already
  // included. Note, we deep copy so that we don't modify config.chainsToFinalize accidentally.
  const configuredChainIds = [...config.chainsToFinalize];
  if (configuredChainIds.length === 0) {
    throw new Error("No chains configured for finalizer");
  }
  if (!configuredChainIds.includes(config.hubPoolChainId)) {
    configuredChainIds.push(config.hubPoolChainId);
  }
  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.hubPoolClient,
    commonClients.configStoreClient,
    config,
    baseSigner,
    config.maxFinalizerLookback,
    configuredChainIds
  );

  return {
    commonClients,
    spokePoolClients,
  };
}

// @dev The HubPoolClient is dependent on the state of the ConfigStoreClient,
//      so update the ConfigStoreClient first. @todo: Use common/ClientHelper.ts.
async function updateFinalizerClients(clients: Clients) {
  await clients.configStoreClient.update();
  await clients.hubPoolClient.update();
}

export async function runFinalizer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;

  // Same config as Dataworker for now.
  const config = new FinalizerConfig(process.env);
  const profiler = new Profiler({
    logger,
    at: "Finalizer#index",
    config,
  });

  logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer started 🏋🏿‍♀️", config });
  const { commonClients, spokePoolClients } = await constructFinalizerClients(logger, config, baseSigner);

  try {
    for (;;) {
      profiler.mark("loopStart");
      await updateSpokePoolClients(spokePoolClients, ["TokensBridged"]);
      profiler.mark("loopStartPostSpokePoolUpdates");

      assert(isDefined(commonClients.hubSigner), "Finalizer: hubSigner not configured");
      await finalize(logger, commonClients.hubSigner, commonClients.hubPoolClient, spokePoolClients, config);

      profiler.mark("loopEndPostFinalizations");

      profiler.measure("timeToUpdateSpokeClients", {
        from: "loopStart",
        to: "loopStartPostSpokePoolUpdates",
        strategy: config.finalizationStrategy,
      });

      profiler.measure("timeToFinalize", {
        from: "loopStartPostSpokePoolUpdates",
        to: "loopEndPostFinalizations",
        strategy: config.finalizationStrategy,
      });

      profiler.measure("loopTime", {
        message: "Time to loop",
        from: "loopStart",
        to: "loopEndPostFinalizations",
        strategy: config.finalizationStrategy,
      });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) {
        break;
      }
    }
  } finally {
    await disconnectRedisClients(logger);
  }
}
