import { utils as sdkUtils } from "@across-protocol/sdk";
import assert from "assert";
import { Contract, ethers } from "ethers";
import { getAddress } from "ethers/lib/utils";
import { groupBy, uniq } from "lodash";
import { AugmentedTransaction, HubPoolClient, MultiCallerClient } from "../clients";
import {
  CONTRACT_ADDRESSES,
  Clients,
  FINALIZER_TOKENBRIDGE_LOOKBACK,
  ProcessEnv,
  constructClients,
  constructSpokePoolClientsWithLookback,
  updateSpokePoolClients,
} from "../common";
import { DataworkerConfig } from "../dataworker/DataworkerConfig";
import { SpokePoolClientsByChain } from "../interfaces";
import {
  Signer,
  blockExplorerLink,
  config,
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
} from "../utils";
import { ChainFinalizer, CrossChainMessage, isAugmentedTransaction } from "./types";
import {
  arbStackFinalizer,
  binanceFinalizer,
  cctpL1toL2Finalizer,
  cctpL2toL1Finalizer,
  heliosL1toL2Finalizer,
  lineaL1ToL2Finalizer,
  lineaL2ToL1Finalizer,
  opStackFinalizer,
  polygonFinalizer,
  scrollFinalizer,
  zkSyncFinalizer,
} from "./utils";
import { assert as ssAssert, enums } from "superstruct";
const { isDefined } = sdkUtils;

config();
let logger: winston.Logger;

/**
 * The finalization type is used to determine the direction of the finalization.
 */
type FinalizationType = "l1->l2" | "l2->l1" | "l1<->l2";

/**
 * A list of finalizers that can be used to finalize messages on a chain. These are
 * broken down into two categories: finalizers that finalize messages on L1 and finalizers
 * that finalize messages on L2.
 * @note: finalizeOnL1 is used to finalize L2 -> L1 messages (from the spoke chain to mainnet)
 * @note: finalizeOnL2 is used to finalize L1 -> L2 messages (from mainnet to the spoke chain)
 */
const chainFinalizers: { [chainId: number]: { finalizeOnL2: ChainFinalizer[]; finalizeOnL1: ChainFinalizer[] } } = {
  // Mainnets
  [CHAIN_IDs.OPTIMISM]: {
    finalizeOnL1: [opStackFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.POLYGON]: {
    finalizeOnL1: [polygonFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.ZK_SYNC]: {
    finalizeOnL1: [zkSyncFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.BASE]: {
    finalizeOnL1: [opStackFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.ALEPH_ZERO]: {
    finalizeOnL1: [arbStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.ARBITRUM]: {
    finalizeOnL1: [arbStackFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.LENS]: {
    finalizeOnL1: [zkSyncFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.LINEA]: {
    finalizeOnL1: [lineaL2ToL1Finalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [lineaL1ToL2Finalizer, cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.SCROLL]: {
    finalizeOnL1: [scrollFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.MODE]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.LISK]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.ZORA]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.REDSTONE]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.BLAST]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.BSC]: {
    finalizeOnL1: [binanceFinalizer],
    finalizeOnL2: [heliosL1toL2Finalizer],
  },
  [CHAIN_IDs.SONEIUM]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.WORLD_CHAIN]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.INK]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.UNICHAIN]: {
    finalizeOnL1: [opStackFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  // Testnets
  [CHAIN_IDs.BASE_SEPOLIA]: {
    finalizeOnL1: [opStackFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: {
    finalizeOnL1: [opStackFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: {
    finalizeOnL1: [opStackFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: {
    finalizeOnL1: [arbStackFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.MODE_SEPOLIA]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.POLYGON_AMOY]: {
    finalizeOnL1: [polygonFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.LISK_SEPOLIA]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
  [CHAIN_IDs.BLAST_SEPOLIA]: {
    finalizeOnL1: [opStackFinalizer],
    finalizeOnL2: [],
  },
};

export async function finalize(
  logger: winston.Logger,
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  configuredChainIds: number[],
  submitFinalizationTransactions: boolean,
  finalizationStrategy: FinalizationType
): Promise<void> {
  const hubChainId = hubPoolClient.chainId;

  // Note: Could move this into a client in the future to manage # of calls and chunk calls based on
  // input byte length.
  const finalizerResponseTxns: { txn: Multicall2Call | AugmentedTransaction; crossChainMessage?: CrossChainMessage }[] =
    [];

  // For each chain, delegate to a handler to look up any TokensBridged events and attempt finalization.
  await sdkUtils.mapAsync(configuredChainIds, async (chainId) => {
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
    const chainSpecificFinalizers: ChainFinalizer[] = [];
    switch (finalizationStrategy) {
      case "l1->l2":
        chainSpecificFinalizers.push(...chainFinalizers[chainId].finalizeOnL2);
        break;
      case "l2->l1":
        chainSpecificFinalizers.push(...chainFinalizers[chainId].finalizeOnL1);
        break;
      case "l1<->l2":
        chainSpecificFinalizers.push(
          ...chainFinalizers[chainId].finalizeOnL1,
          ...chainFinalizers[chainId].finalizeOnL2
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
    const userSpecifiedAddresses: string[] = process.env.FINALIZER_WITHDRAWAL_TO_ADDRESSES
      ? JSON.parse(process.env.FINALIZER_WITHDRAWAL_TO_ADDRESSES).map((address) => ethers.utils.getAddress(address))
      : [];
    const addressesToFinalize = [
      hubPoolClient.hubPool.address,
      spokePoolClients[chainId].spokePool.address,
      CONTRACT_ADDRESSES[hubChainId]?.atomicDepositor?.address,
      ...userSpecifiedAddresses,
    ].map(getAddress);

    // We can subloop through the finalizers for each chain, and then execute the finalizer. For now, the
    // main reason for this is related to CCTP finalizations. We want to run the CCTP finalizer AND the
    // normal finalizer for each chain. This is going to cause an overlap of finalization attempts on USDC.
    // However, that's okay because each finalizer will only attempt to finalize the messages that it is
    // responsible for.
    let totalWithdrawalsForChain = 0;
    let totalDepositsForChain = 0;
    let totalMiscTxnsForChain = 0;
    await sdkUtils.mapAsync(chainSpecificFinalizers, async (finalizer) => {
      try {
        const { callData, crossChainMessages } = await finalizer(
          logger,
          hubSigner,
          hubPoolClient,
          client,
          spokePoolClients[hubChainId],
          addressesToFinalize
        );

        callData.forEach((txn, idx) => {
          finalizerResponseTxns.push({ txn, crossChainMessage: crossChainMessages[idx] });
        });

        totalWithdrawalsForChain += crossChainMessages.filter(({ type }) => type === "withdrawal").length;
        totalDepositsForChain += crossChainMessages.filter(({ type }) => type === "deposit").length;
        totalMiscTxnsForChain += crossChainMessages.filter(({ type }) => type === "misc").length;
      } catch (_e) {
        logger.error({
          at: "finalizer",
          message: `Something errored in a finalizer for chain ${client.chainId}`,
          errorMsg: stringifyThrownValue(_e),
        });
      }
    });
    const totalTransfers = totalWithdrawalsForChain + totalDepositsForChain + totalMiscTxnsForChain;
    logger.debug({
      at: "finalize",
      message: `Found ${totalTransfers} ${network} messages (${totalWithdrawalsForChain} withdrawals | ${totalDepositsForChain} deposits | ${totalMiscTxnsForChain} misc txns) for finalization.`,
    });
  });
  const multicall2Lookup = Object.fromEntries(
    await Promise.all(
      uniq([
        // We always want to include the hub chain in the finalization.
        // since any L2 -> L1 transfers will be finalized on the hub chain.
        hubChainId,
        ...configuredChainIds,
      ]).map(
        async (chainId) =>
          [chainId, await getMultisender(chainId, spokePoolClients[chainId].spokePool.signer)] as [number, Contract]
      )
    )
  );
  // Assert that no multicall2Lookup is undefined
  assert(
    Object.values(multicall2Lookup).every(isDefined),
    `Multicall2 lookup is undefined for chain ids: ${Object.entries(multicall2Lookup)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k)}`
  );

  // @dev use multicaller client to execute batched txn to take advantage of its native txn simulation
  // safety features. This only works because we assume all finalizer transactions are
  // unpermissioned (i.e. msg.sender can be anyone). If this is not true for any chain then we'd need to use
  // the TransactionClient.
  const multicallerClient = new MultiCallerClient(logger);
  let txnRefLookup: Record<number, string[]> = {};
  try {
    const finalizationsByChain = groupBy(
      finalizerResponseTxns,
      ({ crossChainMessage }) => crossChainMessage.destinationChainId
    );

    // @dev Here, we enqueueTransaction individual transactions right away, and we batch all multicalls into `multicallTxns` to enqueue as a single tx right after
    for (const [chainId, finalizations] of Object.entries(finalizationsByChain)) {
      const multicallTxns: Multicall2Call[] = [];

      finalizations.forEach(({ txn }) => {
        if (isAugmentedTransaction(txn)) {
          // It's an AugmentedTransaction, enqueue directly
          txn.nonMulticall = true; // cautiously enforce an invariant that should already be present
          multicallerClient.enqueueTransaction(txn);
        } else {
          // It's a Multicall2Call, collect for batching
          multicallTxns.push(txn);
        }
      });

      if (multicallTxns.length > 0) {
        const txnToSubmit: AugmentedTransaction = {
          contract: multicall2Lookup[Number(chainId)],
          chainId: Number(chainId),
          method: "aggregate",
          args: [multicallTxns],
          gasLimitMultiplier: 2,
          unpermissioned: true,
          message: `Batch finalized ${multicallTxns.length} txns`,
          mrkdwn: `Batch finalized ${multicallTxns.length} txns`,
        };
        multicallerClient.enqueueTransaction(txnToSubmit);
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
      finalizations: finalizerResponseTxns,
    });
    return;
  }

  const { transfers = [], misc = [] } = groupBy(
    finalizerResponseTxns.filter(({ crossChainMessage }) => isDefined(crossChainMessage)),
    ({ crossChainMessage: { type } }) => {
      return type === "misc" ? "misc" : "transfers";
    }
  );

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
    logger.info({
      at: "Finalizer",
      message: `Submitted ${miscReason} on ${destinationNetwork}`,
      infoLogMessage,
      txnRefList: txnRefLookup[destinationChainId]?.map((txnRef) => blockExplorerLink(txnRef, destinationChainId)),
    });
  });
  transfers.forEach(
    ({ crossChainMessage: { originationChainId, destinationChainId, type, amount, l1TokenSymbol: symbol } }) => {
      const originationNetwork = getNetworkName(originationChainId);
      const destinationNetwork = getNetworkName(destinationChainId);
      logger.info({
        at: "Finalizer",
        message: `Finalized ${originationNetwork} ${type} on ${destinationNetwork} for ${amount} ${symbol} 🪃`,
        txnRefList: txnRefLookup[destinationChainId]?.map((txnRef) => blockExplorerLink(txnRef, destinationChainId)),
      });
    }
  );
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
  const hubPoolLookBack = 3600 * 8;
  const commonClients = await constructClients(_logger, config, baseSigner, hubPoolLookBack);
  await updateFinalizerClients(commonClients);

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
//      so update the ConfigStoreClient first. @todo: Use common/ClientHelpter.ts.
async function updateFinalizerClients(clients: Clients) {
  await clients.configStoreClient.update();
  await clients.hubPoolClient.update();
}

export class FinalizerConfig extends DataworkerConfig {
  readonly maxFinalizerLookback: number;
  readonly chainsToFinalize: number[];
  readonly finalizationStrategy: FinalizationType;

  constructor(env: ProcessEnv) {
    const { FINALIZER_MAX_TOKENBRIDGE_LOOKBACK, FINALIZER_CHAINS } = env;
    super(env);

    this.chainsToFinalize = JSON.parse(FINALIZER_CHAINS ?? "[]");

    // `maxFinalizerLookback` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxFinalizerLookback = Number(FINALIZER_MAX_TOKENBRIDGE_LOOKBACK ?? FINALIZER_TOKENBRIDGE_LOOKBACK);
    assert(
      Number.isInteger(this.maxFinalizerLookback),
      `Invalid FINALIZER_MAX_TOKENBRIDGE_LOOKBACK: ${FINALIZER_MAX_TOKENBRIDGE_LOOKBACK}`
    );

    const _finalizationStategy = (env.FINALIZATION_STRATEGY ?? "l1<->l2").toLowerCase();
    ssAssert(_finalizationStategy, enums(["l1->l2", "l2->l1", "l1<->l2"]));
    this.finalizationStrategy = _finalizationStategy;
  }
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

      if (config.finalizerEnabled) {
        const availableChains = commonClients.configStoreClient
          .getChainIdIndicesForBlock()
          .filter((chainId) => isDefined(spokePoolClients[chainId]));

        await finalize(
          logger,
          commonClients.hubSigner,
          commonClients.hubPoolClient,
          spokePoolClients,
          config.chainsToFinalize.length === 0 ? availableChains : config.chainsToFinalize,
          config.sendingTransactionsEnabled,
          config.finalizationStrategy
        );
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Finalizer disabled" });
      }

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
