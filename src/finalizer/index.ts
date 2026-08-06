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
  MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER,
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
  bnZero,
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
): Promise<{ callsToSubmit: Multicall2Call[]; dropped: CrossChainMessage[] }> {
  // @dev Simulate as the multisender, not as the signer: each call executes from Multicall3, and the
  // legacy OptimismPortal keys withdrawal proofs off msg.sender.
  const from = multisender.address;
  const results = await Promise.allSettled(
    finalizations.map(({ txn }) => multisender.provider.call({ from, to: txn.target, data: txn.callData }))
  );

  const callsToSubmit: Multicall2Call[] = [];
  const dropped: CrossChainMessage[] = [];
  const reverted: unknown[] = [];
  const races: unknown[] = [];
  results.forEach((result, idx) => {
    const { txn, crossChainMessage } = finalizations[idx];
    if (isPromiseFulfilled(result)) {
      callsToSubmit.push(txn);
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
 * Groups finalizations into transactions, each sized and each fitting under the per-transaction gas cap.
 *
 * A tryAggregate() batch can't be sized by estimating itself. tryAggregate() catches inner reverts, so a batch whose
 * every call ran out of gas still succeeds, and eth_estimateGas — which returns the lowest limit at which the *outer*
 * transaction succeeds — describes the cost of failing. Nor does padding that estimate help: OP-stack
 * SafeCall.callWithMinGas gates on `gasleft() >= minGas * 64/63`, where minGas was declared by the withdrawal on L2
 * (~5.4M for Across finalizations) and is unrelated to the ~150k the reverting path spends. The gate is invisible to
 * the estimator at any multiplier.
 *
 * So size from the calls themselves: estimate each one alone, and give the batch their sum. Each call needs some
 * amount free when it is invoked and consumes no more than its own estimate, so the sum covers the batch's
 * requirement with room to spare — 12,328,372 against a measured 6,323,632 for the batch that prompted this. That
 * looseness is a limit, not a spend; the gas is not consumed. Estimating per call also reports which call reverts,
 * which an aggregate() estimate cannot: it fails as a whole and names nothing.
 *
 * The sum is not sufficient on its own: it prices the calls, not the tryAggregate() around them, which pays its own
 * intrinsic gas and calldata, dispatches each call and loses 63/64 of what's left forwarding to it. A batch of
 * several calls absorbs that from the 21,000 intrinsic gas every standalone estimate carries and the batch pays
 * once, but a batch of one has no such slack and a proportional multiplier cannot supply it — a lone call estimating
 * at 48,773 needs 54,870 and would be handed 53,650. MULTICALL3_BATCH_GAS_OVERHEAD covers the wrapper as a fixed
 * allowance; MULTICALL3_BATCH_GAS_MULTIPLIER remains for drift against a state that moved since the estimate.
 *
 * A call that doesn't estimate has no size, so it goes in a batch of its own rather than into one whose limit is a
 * sum that excludes it. tryAggregate() contains a revert, but it cannot contain gas exhaustion: an inner call that
 * runs the batch out of gas reverts the outer transaction too, so an unknown cost sharing a sized batch puts every
 * call in it at risk. Measured, a call consuming 636k inside a batch sized at 753k for its other calls starved the
 * call after it; at 12.3M the whole transaction reverted, finalizing nothing and burning the limit. The isolated
 * batch has no sized limit and falls back to the tryAggregate() estimate, which is the honest thing to do with a
 * cost nobody could measure.
 */
export async function buildFinalizationBatches(
  logger: winston.Logger,
  chainId: number,
  multisender: Contract,
  calls: Multicall2Call[]
): Promise<{ calls: Multicall2Call[]; gasLimit?: BigNumber }[]> {
  // Budget under the ceiling for the padding applied at submission, and for the wrapper allowance added below.
  const budget = BigNumber.from(
    Math.floor(MULTICALL3_BATCH_GAS_CEILING / MULTICALL3_BATCH_GAS_MULTIPLIER) - MULTICALL3_BATCH_GAS_OVERHEAD
  );

  // @dev Estimate as the multisender, matching both the pre-flight and the calls' real sender: each executes from
  // Multicall3, and the legacy OptimismPortal keys withdrawal proofs off msg.sender.
  const results = await Promise.allSettled(
    calls.map(({ target, callData }) =>
      multisender.provider.estimateGas({ from: multisender.address, to: target, data: callData })
    )
  );

  // The pre-flight already dropped the calls that revert on their own, so anything failing here moved since.
  const unestimated = results
    .map((result, idx) => ({ result, target: calls[idx].target }))
    .filter(({ result }) => !isPromiseFulfilled(result))
    .map(({ result, target }) => {
      const error = (result as PromiseRejectedResult).reason;
      return { target, reason: isEthersError(error) ? error.reason : isError(error) ? error.message : "unknown error" };
    });
  if (unestimated.length > 0) {
    logger.warn({
      at: "Finalizer#buildFinalizationBatches",
      message: `${unestimated.length} ${getNetworkName(chainId)} finalization(s) no longer estimate 🚨`,
      notificationPath: "across-error",
      unestimated,
    });
  }

  // @dev `sized` keeps the two kinds of batch apart: a call of known cost never joins a batch of unknown ones, and
  // no unknown cost is ever charged against a limit summed from other calls. Consecutive unestimated calls do share
  // a batch — they're already unknown to each other, and the alternative is one wasted transaction each.
  const batches: { calls: Multicall2Call[]; gas: BigNumber; sized: boolean }[] = [];
  calls.forEach((call, idx) => {
    const result = results[idx];
    const batch = batches.at(-1);
    if (!isPromiseFulfilled(result)) {
      if (isDefined(batch) && !batch.sized) {
        batch.calls.push(call);
      } else {
        batches.push({ calls: [call], gas: bnZero, sized: false });
      }
      return;
    }

    const gas = result.value;
    if (isDefined(batch) && batch.sized && batch.gas.add(gas).lte(budget)) {
      batch.calls.push(call);
      batch.gas = batch.gas.add(gas);
    } else {
      batches.push({ calls: [call], gas, sized: true });
    }
  });

  if (batches.length > 1) {
    logger.warn({
      at: "Finalizer#buildFinalizationBatches",
      message: `Split the ${getNetworkName(chainId)} finalization batch across ${batches.length} transactions 🪓`,
      notificationPath: "across-error",
      batchSizes: batches.map(({ calls }) => calls.length),
    });
  }

  // A single call estimating above the budget can't be split any further, and will fail submission rather than
  // mine a no-op. Say so here, or the only evidence is an opaque rejection.
  const oversized = batches.filter(({ gas }) => gas.gt(budget));
  if (oversized.length > 0) {
    logger.warn({
      at: "Finalizer#buildFinalizationBatches",
      message: `${oversized.length} ${getNetworkName(chainId)} finalization(s) exceed the per-transaction gas budget 🚨`,
      notificationPath: "across-error",
      budget: budget.toString(),
      oversized: oversized.map(({ calls, gas }) => ({ target: calls[0].target, gas: gas.toString() })),
    });
  }

  // @dev The summed estimates cover the calls; MULTICALL3_BATCH_GAS_OVERHEAD covers the tryAggregate() around them.
  return batches.map(({ calls, gas, sized }) => ({
    calls,
    gasLimit: sized ? gas.add(MULTICALL3_BATCH_GAS_OVERHEAD) : undefined,
  }));
}

/** The transaction submitting one batch of finalizations. */
export function finalizationBatchTxn(
  chainId: number,
  multisender: Contract,
  { calls, gasLimit }: { calls: Multicall2Call[]; gasLimit?: BigNumber }
): AugmentedTransaction {
  return {
    contract: multisender,
    chainId,
    // @dev tryAggregate over aggregate: a call that starts reverting after the pre-flight
    // must not take the rest of the batch with it.
    method: "tryAggregate",
    args: [false, calls],
    // @dev A sized limit is a real requirement and needs only Multicall3's 1/64 reserve plus a drift margin. A batch
    // whose calls all stopped estimating has no sized limit, and falls back to the tryAggregate() estimate — a floor,
    // which needs the larger pad.
    ...(isDefined(gasLimit)
      ? { gasLimit, gasLimitMultiplier: MULTICALL3_BATCH_GAS_MULTIPLIER }
      : { gasLimitMultiplier: MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER }),
    unpermissioned: true,
    // @dev Batches share a target contract, so without this MultiCallerClient bundles them back into the one
    // transaction that didn't fit — or, with no signer to reach a multisender, into a multicall(bytes[]) that
    // Multicall3 doesn't expose, throwing on encode and abandoning the chain's whole batch.
    nonMulticall: true,
    message: `Batch finalized ${calls.length} txns`,
    mrkdwn: `Batch finalized ${calls.length} txns`,
  };
}

/**
 * Whether a message's finalization actually went out, and why not when it didn't.
 *
 * A chain submits one transaction per batch, and TransactionClient#submit stops at the first failure and returns the
 * hashes it already collected — so a chain with fewer hashes than transactions finalized only some of its messages.
 * Which ones is not recoverable: the hashes don't identify the batches behind them. So every message on a
 * partially-submitted chain is reported unconfirmed rather than credited to a transaction that may not have carried
 * it. Over-warning is the safe direction; a finalization wrongly logged as complete is one nobody goes looking for.
 */
export function submissionStatus(
  chainId: number,
  { dropped, submittedTxns, expectedTxns }: { dropped: boolean; submittedTxns: number; expectedTxns: number }
): { submitted: boolean; reason?: string } {
  if (dropped) {
    return { submitted: false, reason: "dropped by pre-flight simulation ⚠️" };
  }

  if (submittedTxns === 0) {
    return { submitted: false, reason: "no transaction submitted ⚠️" };
  }

  if (submittedTxns < expectedTxns) {
    const network = getNetworkName(chainId);
    return {
      submitted: false,
      reason: `only ${submittedTxns}/${expectedTxns} ${network} transactions submitted; this message may not be in one of them ⚠️`,
    };
  }

  return { submitted: true };
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
    const enqueuedTxnCount: Record<number, number> = {};
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
            const batches = await buildFinalizationBatches(logger, Number(chainId), multisender, multicallTxns);
            batches.forEach((batch) =>
              multicallerClient.enqueueTransaction(finalizationBatchTxn(Number(chainId), multisender, batch))
            );
          }
        }
      }

      // @dev Record the queue depth before executing, which clears it. Every finalizer transaction is nonMulticall,
      // so MultiCallerClient submits them one-for-one and this is the number of hashes a fully-submitted chain
      // returns. Needed because TransactionClient#submit stops at the first failure and returns the hashes it
      // already has, so a short hash list is the only evidence that some finalizations never went out.
      Object.keys(finalizationsByChain).forEach((chainId) => {
        enqueuedTxnCount[Number(chainId)] = multicallerClient.getQueuedTransactions(Number(chainId)).length;
      });
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
      const { submitted, reason } = submissionStatus(destinationChainId, {
        dropped,
        submittedTxns: txnRefLookup[destinationChainId]?.length ?? 0,
        expectedTxns: enqueuedTxnCount[destinationChainId] ?? 0,
      });

      // Nothing is submitted when transaction sending is disabled, so don't warn about it.
      const level = submitted || !submitFinalizationTransactions ? "info" : "warn";
      return {
        level,
        fields: {
          txnRefList: dropped
            ? undefined
            : txnRefLookup[destinationChainId]?.map((txnRef) => blockExplorerLink(txnRef, destinationChainId)),
          ...(level === "warn" ? { notificationPath: "across-error", notSubmitted: reason } : {}),
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
