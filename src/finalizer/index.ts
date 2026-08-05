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
  EIP7825_TXN_GAS_CAP,
  MULTICALL3_BATCH_GAS_CEILING,
  MULTICALL3_BATCH_GAS_MULTIPLIER,
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
  toBNWei,
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
 * Sizes a tryAggregate() batch by estimating the same calls as aggregate().
 *
 * eth_estimateGas cannot size tryAggregate(requireSuccess=false) directly. It returns the lowest limit at which the
 * *outer* transaction succeeds, and tryAggregate() catches inner reverts — so a batch whose every call ran out of gas
 * still succeeds, and the estimate describes the cost of *failing*. Padding it is not enough when a call's gas
 * requirement is not a function of what it consumes: OP-stack `SafeCall.callWithMinGas` gates on
 * `gasleft() >= minGas * 64/63` where `minGas` was declared by the withdrawal on L2 (~5.4M for Across
 * finalizations), while the reverting path consumes ~150k. The estimator never sees the gate, so no fixed multiplier
 * reaches it.
 *
 * aggregate() has no such blind spot: any inner revert is fatal to the outer call, so the estimator's search cannot
 * return a limit below every call's true requirement. Size with aggregate(), submit as tryAggregate() — a truthful
 * limit, and a revert that appears after the pre-flight still can't take the rest of the batch with it.
 *
 * Sizing this way does mean one bad call can spoil the *estimate*, which is the failure mode #3660 removed from
 * execution. It does not come back: the batch is still submitted as tryAggregate(), so the healthy calls still land.
 * But the fallback must not be the tryAggregate() estimate, or a single bad call silently re-imposes the floor on
 * every other call in the batch. So fall back to estimating each call on its own, which sees each requirement with no
 * call able to spoil another's, and sum them. The pre-flight has already dropped the calls that revert alone, so
 * reaching the fallback means a call that only reverts in combination, or state that moved since.
 *
 * The sum over-provisions when several calls carry a large minGas — the reserve is a floor each call must be *given*,
 * not gas it spends, so successive calls reuse it rather than accumulating (2 x 5.83M sums to 11.65M where the batch
 * needs 6.13M). That buys safety on a rare path at the cost of a loose limit, not a loose spend; the gas is not
 * consumed.
 *
 * Returns undefined only if no call estimates at all, leaving the caller with the padded tryAggregate() estimate.
 */
async function sizeTryAggregateBatch(
  logger: winston.Logger,
  chainId: number,
  multisender: Contract,
  calls: Multicall2Call[]
): Promise<BigNumber | undefined> {
  try {
    return await multisender.estimateGas.aggregate(calls);
  } catch (error) {
    const estimates = (await estimateCallGas(multisender, calls)).filter(isDefined);
    logger.warn({
      at: "Finalizer#sizeTryAggregateBatch",
      message: `Sized the ${getNetworkName(chainId)} finalization batch per-call: it does not estimate as aggregate() 🚨`,
      notificationPath: "across-error",
      reason: isEthersError(error) ? error.reason : isError(error) ? error.message : "unknown error",
      estimated: estimates.length,
      calls: calls.length,
    });

    return estimates.length > 0 ? estimates.reduce((sum, gas) => sum.add(gas), bnZero) : undefined;
  }
}

/**
 * Each call's gas requirement, estimated independently of the others. undefined where a call doesn't estimate, which
 * means it reverts — tryAggregate() will isolate it, so it doesn't need funding.
 */
async function estimateCallGas(multisender: Contract, calls: Multicall2Call[]): Promise<(BigNumber | undefined)[]> {
  // @dev Estimate as the multisender, matching both the pre-flight and the calls' real sender: each executes from
  // Multicall3, and the legacy OptimismPortal keys withdrawal proofs off msg.sender.
  const results = await Promise.allSettled(
    calls.map(({ target, callData }) =>
      multisender.provider.estimateGas({ from: multisender.address, to: target, data: callData })
    )
  );
  return results.map((result) => (isPromiseFulfilled(result) ? result.value : undefined));
}

/**
 * The gas limit a sized batch reaches the wire with, mirroring how TransactionClient#submit applies the multiplier.
 */
function padGasLimit(gasLimit: BigNumber): BigNumber {
  return gasLimit.mul(toBNWei(MULTICALL3_BATCH_GAS_MULTIPLIER)).div(sdkUtils.fixedPointAdjustment);
}

/**
 * Splits a finalization batch into transactions that each fit under the per-transaction gas cap.
 *
 * EIP-7825 caps a single transaction at 2^24 = 16,777,216 gas, two orders of magnitude below mainnet's ~60M block gas
 * limit — so the cap on the transaction, not the block, is what bounds a batch. The finalizer enqueues one
 * tryAggregate() per chain and MultiCallerClient passes a single-element multisender chunk through untouched, so
 * nothing else divides it: a backlog large enough to need more than MULTICALL3_BATCH_GAS_CEILING has, until now, gone
 * to the wire whole and been rejected in full.
 *
 * The whole batch is sized first, so the common case costs no extra RPC and submits exactly as before — the two
 * withdrawals stuck on 2026-08-05 size at 6.17M against a 15M ceiling. Only a batch that doesn't fit pays for
 * per-call estimates and is split.
 *
 * Packing uses the per-call estimates rather than each candidate chunk's aggregate() estimate, which leaves chunks
 * smaller than strictly necessary: the sum over-counts a shared minGas reserve, and each per-call estimate also
 * carries its own intrinsic and cold-access gas that aggregate() pays once for the whole batch. Every chunk is then
 * sized properly by sizeTryAggregateBatch(), and a conservative split is the safe direction to err. The sizes are
 * rechecked against the ceiling afterwards, because the sum understates in one direction — a call that doesn't
 * estimate on its own contributes nothing to packing while still consuming gas in its chunk. A single call that alone
 * exceeds the ceiling cannot be split any further; it goes out on its own and is logged, so it fails submission
 * loudly instead of quietly dragging a batch over the cap.
 */
export async function chunkFinalizationBatch(
  logger: winston.Logger,
  chainId: number,
  multisender: Contract,
  calls: Multicall2Call[]
): Promise<{ calls: Multicall2Call[]; gasLimit?: BigNumber }[]> {
  // @dev The ceiling applies to the padded limit that reaches the wire, so the budget for a sized batch is lower.
  const budget = BigNumber.from(Math.floor(MULTICALL3_BATCH_GAS_CEILING / MULTICALL3_BATCH_GAS_MULTIPLIER));

  const gasLimit = await sizeTryAggregateBatch(logger, chainId, multisender, calls);
  // @dev An unsizeable batch has nothing to pack against; leave it whole for the padded tryAggregate() estimate.
  if (!isDefined(gasLimit) || gasLimit.lte(budget)) {
    return [{ calls, gasLimit }];
  }

  const perCall = await estimateCallGas(multisender, calls);
  const chunks: Multicall2Call[][] = [];
  let current: Multicall2Call[] = [];
  let chunkGas = bnZero;
  let oversized = 0;
  calls.forEach((call, idx) => {
    const gas = perCall[idx] ?? bnZero;
    oversized += gas.gt(budget) ? 1 : 0;
    if (current.length > 0 && chunkGas.add(gas).gt(budget)) {
      chunks.push(current);
      current = [];
      chunkGas = bnZero;
    }
    current.push(call);
    chunkGas = chunkGas.add(gas);
  });
  chunks.push(current);

  logger.warn({
    at: "Finalizer#chunkFinalizationBatch",
    message: `Split the ${getNetworkName(chainId)} finalization batch across ${chunks.length} transactions 🪓`,
    notificationPath: "across-error",
    reason: `sized at ${gasLimit.toString()}, over the ${budget.toString()} budget`,
    calls: calls.length,
    chunkSizes: chunks.map(({ length }) => length),
    oversizedCalls: oversized > 0 ? oversized : undefined,
  });

  const sized = await Promise.all(
    chunks.map(async (chunk) => ({
      calls: chunk,
      gasLimit: await sizeTryAggregateBatch(logger, chainId, multisender, chunk),
    }))
  );

  // @dev Packing counts per-call estimates but a chunk is sized as aggregate(), so the two can disagree. Measured,
  // the per-call sum runs well over: each call's estimate carries its own 21k intrinsic gas and its own cold-access
  // costs, ~40k a call that aggregate() pays once, against Multicall3's much smaller per-call loop overhead (50
  // uniform calls: 3.37M summed vs 1.38M aggregated; 20 larger ones: 11.76M vs 11.03M). But the sum understates
  // whenever a call doesn't estimate on its own, since it then contributes nothing to packing while still consuming
  // gas in the chunk — and the pre-flight admits calls on eth_call, which is more permissive than eth_estimateGas.
  // So verify rather than assume, and say which side of the hard cap we landed on.
  const overBudget = sized
    .map(({ gasLimit: chunkGas }) => (isDefined(chunkGas) ? padGasLimit(chunkGas) : undefined))
    .filter(isDefined)
    .filter((padded) => padded.gt(MULTICALL3_BATCH_GAS_CEILING));
  if (overBudget.length > 0) {
    const overCap = overBudget.filter((padded) => padded.gt(EIP7825_TXN_GAS_CAP));
    logger[overCap.length > 0 ? "error" : "warn"]({
      at: "Finalizer#chunkFinalizationBatch",
      message:
        overCap.length > 0
          ? `${overCap.length} ${getNetworkName(chainId)} finalization chunk(s) still exceed the per-transaction gas cap 🚨`
          : `${overBudget.length} ${getNetworkName(chainId)} finalization chunk(s) sized above the batch ceiling ⚠️`,
      notificationPath: "across-error",
      reason: "a chunk sized higher than the per-call estimates it was packed against",
      ceiling: MULTICALL3_BATCH_GAS_CEILING,
      cap: EIP7825_TXN_GAS_CAP,
      paddedLimits: overBudget.map((padded) => padded.toString()),
    });
  }

  return sized;
}

/**
 * Whether a message's finalization actually went out, and why not when it didn't.
 *
 * A chain submits one transaction per batch chunk, and TransactionClient#submit stops at the first failure and
 * returns the hashes it already collected — so a chain with fewer hashes than transactions finalized only some of its
 * messages. Which ones is not recoverable: the hashes don't identify the chunks behind them, and a chunk's calls
 * aren't tracked past enqueueing. So every message on a partially-submitted chain is reported unconfirmed rather than
 * credited to a transaction that may not have carried it. Over-warning on the messages that did land is the safe
 * direction; a finalization wrongly logged as complete is one nobody goes looking for.
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

/**
 * The transaction that submits one chunk of a finalization batch.
 *
 * nonMulticall is what makes the split reach the wire. Chunks share a target contract, so without it
 * MultiCallerClient would bundle them back up: this client is constructed without a signer, so it can't reach a
 * multisender and falls through to wrapping them in multicall(bytes[]) — which Multicall3 doesn't expose, so
 * encoding throws and the chain's entire batch is abandoned. Given a multisender it would instead re-aggregate the
 * chunks into the single transaction that didn't fit in the first place. Neither is what a split is for.
 */
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
    // @dev A sized limit is a real requirement and needs only a state-drift margin. Only an unsizeable batch falls
    // through to the tryAggregate() estimate, which is a floor and must also absorb the EIP-150 reserve.
    ...(isDefined(gasLimit)
      ? { gasLimit, gasLimitMultiplier: MULTICALL3_BATCH_GAS_MULTIPLIER }
      : { gasLimitMultiplier: MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER }),
    unpermissioned: true,
    nonMulticall: true,
    message: `Batch finalized ${calls.length} txns`,
    mrkdwn: `Batch finalized ${calls.length} txns`,
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
            // @dev A tryAggregate() estimate describes the cost of failing, not the cost of succeeding; size the
            // batch as aggregate() instead, and split it if it won't fit in one transaction. See
            // sizeTryAggregateBatch() and chunkFinalizationBatch().
            const batches = await chunkFinalizationBatch(logger, Number(chainId), multisender, multicallTxns);
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
