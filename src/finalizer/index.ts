import { utils as sdkUtils } from "@across-protocol/sdk";
import assert from "assert";
import { Contract, ethers } from "ethers";
import { getAddress } from "ethers/lib/utils";
import { groupBy, uniq } from "lodash";
import { AugmentedTransaction, HubPoolClient, MultiCallerClient, TransactionClient } from "../clients";
import {
  CONTRACT_ADDRESSES,
  Clients,
  CommonConfig,
  FINALIZER_TOKENBRIDGE_LOOKBACK,
  ProcessEnv,
  constructClients,
  constructSpokePoolClientsWithLookback,
  updateSpokePoolClients,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import {
  BigNumber,
  bnZero,
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
  isEVMSpokePoolClient,
  chainIsEvm,
  EvmAddress,
  Address,
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

dotenvConfig();
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
  [CHAIN_IDs.SOLANA]: {
    finalizeOnL1: [cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
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
    finalizeOnL1: [opStackFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
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
  config: FinalizerConfig
): Promise<void> {
  const hubChainId = hubPoolClient.chainId;

  const {
    chainsToFinalize: configuredChainIds,
    finalizationStrategy,
    sendingTransactionsEnabled: submitFinalizationTransactions,
  } = config;

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
    const addressesToFinalize: Address[] = [
      hubPoolClient.hubPool.address,
      CONTRACT_ADDRESSES[hubChainId]?.atomicDepositor?.address,
      ...config.userAddresses,
    ].map((address) => EvmAddress.from(getAddress(address)));
    addressesToFinalize.push(spokePoolClients[chainId].spokePoolAddress);

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
  const multicall2Lookup = Object.fromEntries(
    await Promise.all(
      uniq([
        // We always want to include the hub chain in the finalization.
        // since any L2 -> L1 transfers will be finalized on the hub chain.
        hubChainId,
        ...configuredChainIds,
      ])
        .filter(chainIsEvm)
        .map(async (chainId) => {
          const spokePoolClient = spokePoolClients[chainId];
          assert(isEVMSpokePoolClient(spokePoolClient));
          return [chainId, await getMultisender(chainId, spokePoolClient.spokePool.signer)] as [number, Contract];
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

  const txnClient = new TransactionClient(logger);

  let gasEstimation = bnZero;
  const batchGasLimit = BigNumber.from(10_000_000);
  // @dev To avoid running into block gas limit in case the # of finalizations gets too high, keep a running
  // counter of the approximate gas estimation and cut off the list of finalizations if it gets too high.

  // Ensure each transaction would succeed in isolation.
  const finalizations = await sdkUtils.filterAsync(finalizerResponseTxns, async ({ txn: _txn, crossChainMessage }) => {
    let simErrorReason: string;
    if (!isAugmentedTransaction(_txn)) {
      // Multicall transaction simulation flow
      const txnToSubmit: AugmentedTransaction = {
        contract: multicall2Lookup[crossChainMessage.destinationChainId],
        chainId: crossChainMessage.destinationChainId,
        method: "aggregate",
        // aggregate() takes an array of tuples: [calldata: bytes, target: address].
        args: [[_txn]],
      };
      const [{ reason, succeed, transaction }] = await txnClient.simulate([txnToSubmit]);

      if (succeed) {
        // Increase running counter of estimated gas cost for batch finalization.
        // gasLimit should be defined if succeed is True.
        const updatedGasEstimation = gasEstimation.add(transaction.gasLimit);
        if (updatedGasEstimation.lt(batchGasLimit)) {
          gasEstimation = updatedGasEstimation;
          return true;
        } else {
          return false;
        }
      } else {
        simErrorReason = reason;
      }
    } else {
      // Individual transaction simulation flow
      const [{ reason, succeed }] = await txnClient.simulate([_txn]);
      if (succeed) {
        return true;
      } else {
        simErrorReason = reason;
      }
    }

    // Simulation failed, log the reason and continue.
    let message: string;
    if (isDefined(crossChainMessage)) {
      const { originationChainId, destinationChainId, type, l1TokenSymbol, amount } = crossChainMessage;
      const originationNetwork = getNetworkName(originationChainId);
      const destinationNetwork = getNetworkName(destinationChainId);
      message = `Failed to estimate gas for ${originationNetwork} -> ${destinationNetwork} ${amount} ${l1TokenSymbol} ${type}.`;
    } else {
      // @dev Likely to be the 2nd part of a 2-stage withdrawal (i.e. retrieve() on the Polygon bridge adapter).
      message = "Unknown finalizer simulation failure.";
    }
    logger.warn({ at: "finalizer", message, simErrorReason, txn: _txn });
    return false;
  });

  if (finalizations.length > 0) {
    // @dev use multicaller client to execute batched txn to take advantage of its native txn simulation
    // safety features. This only works because we assume all finalizer transactions are
    // unpermissioned (i.e. msg.sender can be anyone). If this is not true for any chain then we'd need to use
    // the TransactionClient.
    const multicallerClient = new MultiCallerClient(logger);
    let txnRefLookup: Record<number, string[]> = {};
    try {
      const finalizationsByChain = groupBy(
        finalizations,
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
            gasLimit: gasEstimation,
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
        finalizations,
      });
      return;
    }

    const { transfers = [], misc = [] } = groupBy(
      finalizations.filter(({ crossChainMessage }) => isDefined(crossChainMessage)),
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

export class FinalizerConfig extends CommonConfig {
  public readonly finalizationStrategy: FinalizationType;
  public readonly maxFinalizerLookback: number;
  public readonly userAddresses: string[];
  public chainsToFinalize: number[];

  constructor(env: ProcessEnv) {
    const {
      FINALIZER_MAX_TOKENBRIDGE_LOOKBACK,
      FINALIZER_CHAINS = "[]",
      FINALIZER_WITHDRAWAL_TO_ADDRESSES = "[]",
      FINALIZATION_STRATEGY = "l1<->l2",
    } = env;
    super(env);

    const userAddresses = JSON.parse(FINALIZER_WITHDRAWAL_TO_ADDRESSES);
    assert(Array.isArray(userAddresses), "FINALIZER_WITHDRAWAL_TO_ADDRESSES must be a JSON string array");
    this.userAddresses = userAddresses.map(ethers.utils.getAddress);

    this.chainsToFinalize = JSON.parse(FINALIZER_CHAINS);

    // `maxFinalizerLookback` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxFinalizerLookback = Number(FINALIZER_MAX_TOKENBRIDGE_LOOKBACK ?? FINALIZER_TOKENBRIDGE_LOOKBACK);
    assert(
      Number.isInteger(this.maxFinalizerLookback),
      `Invalid FINALIZER_MAX_TOKENBRIDGE_LOOKBACK: ${FINALIZER_MAX_TOKENBRIDGE_LOOKBACK}`
    );

    const _finalizationStrategy = FINALIZATION_STRATEGY.toLowerCase();
    ssAssert(_finalizationStrategy, enums(["l1->l2", "l2->l1", "l1<->l2"]));
    this.finalizationStrategy = _finalizationStrategy;
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
