import { CCTP_NO_DOMAIN, ChainFamily, PRODUCTION_NETWORKS } from "@across-protocol/constants";
import { utils as sdkUtils, typeguards } from "@across-protocol/sdk";
import assert from "assert";
import { BigNumber, Contract } from "ethers";
import { AugmentedTransaction, HubPoolClient, knownRevertReasons, MultiCallerClient } from "../clients";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsWithLookback,
  getContractEntry,
  MULTICALL3_BATCH_GAS_CEILING,
  MULTICALL3_BATCH_GAS_MULTIPLIER,
  MULTICALL3_BATCH_GAS_OVERHEAD,
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
const { isError, isEthersError } = typeguards;

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

/**
 * Simulate each finalization individually before batching. aggregate() is all-or-nothing and hides the
 * inner revert reason, so one bad call would otherwise silently block every other finalization.
 * @returns The calls that simulated successfully, and the messages dropped for reverting.
 */
async function preflightFinalizations(
  logger: winston.Logger,
  chainId: number,
  multisender: Contract,
  finalizations: { txn: Multicall2Call; crossChainMessage: CrossChainMessage }[]
): Promise<{
  callsToSubmit: { txn: Multicall2Call; crossChainMessage: CrossChainMessage }[];
  dropped: CrossChainMessage[];
}> {
  // @dev Simulate as the multisender, not as the signer: each call executes from Multicall3, and the
  // legacy OptimismPortal keys withdrawal proofs off msg.sender.
  const from = multisender.address;
  const results = await Promise.allSettled(
    finalizations.map(({ txn }) => multisender.provider.call({ from, to: txn.target, data: txn.callData }))
  );

  const callsToSubmit: { txn: Multicall2Call; crossChainMessage: CrossChainMessage }[] = [];
  const dropped: CrossChainMessage[] = [];
  const reverted: unknown[] = [];
  const races: unknown[] = [];
  results.forEach((result, idx) => {
    const { txn, crossChainMessage } = finalizations[idx];
    if (isPromiseFulfilled(result)) {
      callsToSubmit.push({ txn, crossChainMessage });
      return;
    }

    const error = result.reason;
    const reason = isEthersError(error) ? error.reason : isError(error) ? error.message : "unknown error";
    const { originationChainId, destinationChainId, type } = crossChainMessage;
    const detail = {
      originationChain: getNetworkName(originationChainId),
      destinationChain: getNetworkName(destinationChainId),
      type,
      amount: "amount" in crossChainMessage ? crossChainMessage.amount : undefined,
      l1TokenSymbol: "l1TokenSymbol" in crossChainMessage ? crossChainMessage.l1TokenSymbol : undefined,
      target: txn.target,
      reason,
    };

    dropped.push(crossChainMessage);
    // A concurrent finalizer may have claimed this message already; that's a race, not a fault.
    const isRace = [...knownRevertReasons].some((known) => reason.toLowerCase().includes(known.toLowerCase()));
    (isRace ? races : reverted).push(detail);
  });

  if (races.length > 0) {
    logger.debug({
      at: "Finalizer#preflightFinalizations",
      message: `Dropped ${races.length} already-finalized ${getNetworkName(chainId)} message(s).`,
      races,
    });
  }

  if (reverted.length > 0) {
    logger.warn({
      at: "Finalizer#preflightFinalizations",
      message: `Excluded ${reverted.length} reverting finalization(s) from the ${getNetworkName(chainId)} batch 🚨`,
      notificationPath: "across-error",
      reverted,
    });
  }

  return { callsToSubmit, dropped };
}

/**
 * Splits finalizations into batches, each sized from its calls' own estimates. tryAggregate() catches inner reverts,
 * so estimating the batch prices the failure; and padding that never reaches OP-stack callWithMinGas, which gates on
 * gasleft() rather than on what the call spends. A call that no longer estimates has no size, so it is dropped
 * rather than charged against a limit summed from its neighbours.
 */
export async function buildFinalizationBatches(
  logger: winston.Logger,
  chainId: number,
  multisender: Contract,
  finalizations: { txn: Multicall2Call; crossChainMessage: CrossChainMessage }[]
): Promise<{ batches: { calls: Multicall2Call[]; gasLimit: BigNumber }[]; dropped: CrossChainMessage[] }> {
  // Budget under the ceiling for the padding applied at submission, and for the wrapper allowance added below.
  const budget = BigNumber.from(
    Math.floor(MULTICALL3_BATCH_GAS_CEILING / MULTICALL3_BATCH_GAS_MULTIPLIER) - MULTICALL3_BATCH_GAS_OVERHEAD
  );

  // @dev Estimate as the multisender, matching both the pre-flight and the calls' real sender: each executes from
  // Multicall3, and the legacy OptimismPortal keys withdrawal proofs off msg.sender.
  const results = await Promise.allSettled(
    finalizations.map(({ txn: { target, callData } }) =>
      multisender.provider.estimateGas({ from: multisender.address, to: target, data: callData })
    )
  );

  // The pre-flight already dropped the calls that revert on their own, so anything failing here moved since.
  const dropped: CrossChainMessage[] = [];
  const unestimated: unknown[] = [];
  const batches: { calls: Multicall2Call[]; gas: BigNumber }[] = [];
  finalizations.forEach(({ txn, crossChainMessage }, idx) => {
    const result = results[idx];
    if (!isPromiseFulfilled(result)) {
      const error = result.reason;
      dropped.push(crossChainMessage);
      unestimated.push({
        target: txn.target,
        reason: isEthersError(error) ? error.reason : isError(error) ? error.message : "unknown error",
      });
      return;
    }

    const gas = result.value;
    const batch = batches.at(-1);
    if (isDefined(batch) && batch.gas.add(gas).lte(budget)) {
      batch.calls.push(txn);
      batch.gas = batch.gas.add(gas);
    } else {
      batches.push({ calls: [txn], gas });
    }
  });

  if (unestimated.length > 0) {
    logger.warn({
      at: "Finalizer#buildFinalizationBatches",
      message: `Dropped ${unestimated.length} ${getNetworkName(chainId)} finalization(s) that no longer estimate 🚨`,
      notificationPath: "across-error",
      unestimated,
    });
  }

  if (batches.length > 1) {
    logger.warn({
      at: "Finalizer#buildFinalizationBatches",
      message: `Split the ${getNetworkName(chainId)} finalization batch across ${batches.length} transactions 🪓`,
      notificationPath: "across-error",
      batchSizes: batches.map(({ calls }) => calls.length),
    });
  }

  // @dev The summed estimates cover the calls; MULTICALL3_BATCH_GAS_OVERHEAD covers the tryAggregate() around them.
  return {
    batches: batches.map(({ calls, gas }) => ({ calls, gasLimit: gas.add(MULTICALL3_BATCH_GAS_OVERHEAD) })),
    dropped,
  };
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

  // Messages dropped by pre-flight, so their log lines below don't claim they were finalized.
  const droppedMessages = new Set<CrossChainMessage>();

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
    try {
      const finalizationsByChain = Object.groupBy(
        finalizations,
        ({ crossChainMessage }) => crossChainMessage.destinationChainId
      );

      // @dev Here, we enqueueTransaction individual transactions right away, and we batch all multicalls into `multicallTxns` to enqueue as a single tx right after
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
          const { callsToSubmit: multicallTxns, dropped } = await preflightFinalizations(
            logger,
            Number(chainId),
            multisender,
            multicallFinalizations
          );
          dropped.forEach((crossChainMessage) => droppedMessages.add(crossChainMessage));
          if (multicallTxns.length > 0) {
            const { batches, dropped: unestimated } = await buildFinalizationBatches(
              logger,
              Number(chainId),
              multisender,
              multicallTxns
            );
            unestimated.forEach((crossChainMessage) => droppedMessages.add(crossChainMessage));
            batches.forEach(({ calls, gasLimit }) =>
              multicallerClient.enqueueTransaction({
                contract: multisender,
                chainId: Number(chainId),
                // @dev tryAggregate over aggregate: a call that starts reverting after the pre-flight
                // must not take the rest of the batch with it.
                method: "tryAggregate",
                args: [false, calls],
                // @dev A sized limit is a real requirement, not the floor a tryAggregate() estimate gives.
                gasLimit,
                gasLimitMultiplier: MULTICALL3_BATCH_GAS_MULTIPLIER,
                unpermissioned: true,
                // @dev Batches share a target; without this MultiCallerClient bundles them back together.
                nonMulticall: true,
                message: `Batch finalized ${calls.length} txns`,
                mrkdwn: `Batch finalized ${calls.length} txns`,
              })
            );
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

    // @dev These lines come from crossChainMessages, not from what landed, so a message that was dropped
    // or never submitted still reads as success. Report per message rather than per chain.
    const submission = (crossChainMessage: CrossChainMessage) => {
      const { destinationChainId } = crossChainMessage;
      const dropped = droppedMessages.has(crossChainMessage);
      const submitted = !dropped && txnRefLookup[destinationChainId]?.length > 0;

      // Nothing is submitted when transaction sending is disabled, so don't warn about it.
      const level = submitted || !submitFinalizationTransactions ? "info" : "warn";
      return {
        level,
        fields: {
          txnRefList: dropped
            ? undefined
            : txnRefLookup[destinationChainId]?.map((txnRef) => blockExplorerLink(txnRef, destinationChainId)),
          ...(level === "warn"
            ? {
                notificationPath: "across-error",
                notSubmitted: dropped ? "dropped before submission ⚠️" : "no transaction submitted ⚠️",
              }
            : {}),
        },
      } as const;
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
      const { level, fields } = submission(crossChainMessage);
      logger[level]({
        at: "Finalizer",
        message: `Submitted ${miscReason} on ${destinationNetwork}`,
        infoLogMessage,
        ...fields,
      });
    });
    transfers.forEach(({ crossChainMessage }) => {
      const { originationChainId, destinationChainId, type, amount, l1TokenSymbol: symbol } = crossChainMessage;
      const originationNetwork = getNetworkName(originationChainId);
      const destinationNetwork = getNetworkName(destinationChainId);
      const { level, fields } = submission(crossChainMessage);
      logger[level]({
        at: "Finalizer",
        message: `Finalized ${originationNetwork} ${type} on ${destinationNetwork} for ${amount} ${symbol} 🪃`,
        ...fields,
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
