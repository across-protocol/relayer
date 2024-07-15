import { utils as sdkUtils } from "@across-protocol/sdk";
import assert from "assert";
import { BigNumber, Contract, constants } from "ethers";
import { getAddress } from "ethers/lib/utils";
import { groupBy, uniq } from "lodash";
import { AugmentedTransaction, HubPoolClient, MultiCallerClient, TransactionClient } from "../clients";
import {
  CONTRACT_ADDRESSES,
  Clients,
  FINALIZER_TOKENBRIDGE_LOOKBACK,
  Multicall2Call,
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
  processEndPollingLoop,
  startupLogLevel,
  winston,
  CHAIN_IDs,
} from "../utils";
import { ChainFinalizer, CrossChainMessage } from "./types";
import {
  arbitrumOneFinalizer,
  cctpL1toL2Finalizer,
  cctpL2toL1Finalizer,
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
  [CHAIN_IDs.ARBITRUM]: {
    finalizeOnL1: [arbitrumOneFinalizer, cctpL2toL1Finalizer],
    finalizeOnL2: [cctpL1toL2Finalizer],
  },
  [CHAIN_IDs.LINEA]: {
    finalizeOnL1: [lineaL2ToL1Finalizer],
    finalizeOnL2: [lineaL1ToL2Finalizer],
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
  // Testnets
  [CHAIN_IDs.BASE_SEPOLIA]: {
    finalizeOnL1: [cctpL2toL1Finalizer],
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
};

function enrichL1ToL2AddressesToFinalize(l1ToL2AddressesToFinalize: string[], addressesToEnsure: string[]): string[] {
  const resultingAddresses = l1ToL2AddressesToFinalize.slice().map(getAddress);
  for (const address of addressesToEnsure) {
    const checksummedAddress = getAddress(address);
    if (!resultingAddresses.includes(checksummedAddress)) {
      resultingAddresses.push(checksummedAddress);
    }
  }
  return resultingAddresses;
}

export async function finalize(
  logger: winston.Logger,
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  configuredChainIds: number[],
  l1ToL2AddressesToFinalize: string[],
  submitFinalizationTransactions: boolean,
  finalizationStrategy: FinalizationType
): Promise<void> {
  const hubChainId = hubPoolClient.chainId;

  // Note: Could move this into a client in the future to manage # of calls and chunk calls based on
  // input byte length.
  const finalizationsToBatch: { txn: Multicall2Call; crossChainMessage?: CrossChainMessage }[] = [];

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

    // For certain chains we always want to track certain addresses for finalization:
    // If the chain needs an L1->L2 finalization, always track HubPool, AtomicDepositor. HubPool sends messages and
    // tokens to the SpokePool, while the relayer rebalances ETH via the AtomicDepositor
    if (sdkUtils.chainRequiresL1ToL2Finalization(chainId)) {
      const addressesToEnsure = [
        hubPoolClient.hubPool.address,
        CONTRACT_ADDRESSES[hubChainId]?.atomicDepositor?.address,
      ];
      // Add the spoke pool address to the list of addresses to ensure.
      addressesToEnsure.push(spokePoolClients[chainId].spokePool.address);
      l1ToL2AddressesToFinalize = enrichL1ToL2AddressesToFinalize(l1ToL2AddressesToFinalize, addressesToEnsure);
    }

    // We can subloop through the finalizers for each chain, and then execute the finalizer. For now, the
    // main reason for this is related to CCTP finalizations. We want to run the CCTP finalizer AND the
    // normal finalizer for each chain. This is going to cause an overlap of finalization attempts on USDC.
    // However, that's okay because each finalizer will only attempt to finalize the messages that it is
    // responsible for.
    let totalWithdrawalsForChain = 0;
    let totalDepositsForChain = 0;
    let totalMiscTxnsForChain = 0;
    await sdkUtils.mapAsync(chainSpecificFinalizers, async (finalizer) => {
      const { callData, crossChainMessages } = await finalizer(
        logger,
        hubSigner,
        hubPoolClient,
        client,
        l1ToL2AddressesToFinalize
      );

      callData.forEach((txn, idx) => {
        finalizationsToBatch.push({ txn, crossChainMessage: crossChainMessages[idx] });
      });

      totalWithdrawalsForChain += crossChainMessages.filter(({ type }) => type === "withdrawal").length;
      totalDepositsForChain += crossChainMessages.filter(({ type }) => type === "deposit").length;
      totalMiscTxnsForChain += crossChainMessages.filter(({ type }) => type === "misc").length;
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

  const txnClient = new TransactionClient(logger);

  let gasEstimation = constants.Zero;
  const batchGasLimit = BigNumber.from(10_000_000);
  // @dev To avoid running into block gas limit in case the # of finalizations gets too high, keep a running
  // counter of the approximate gas estimation and cut off the list of finalizations if it gets too high.

  // Ensure each transaction would succeed in isolation.
  const finalizations = await sdkUtils.filterAsync(finalizationsToBatch, async ({ txn: _txn, crossChainMessage }) => {
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
    logger.warn({ at: "finalizer", message, reason, txn: _txn });
    return false;
  });

  if (finalizations.length > 0) {
    // @dev use multicaller client to execute batched txn to take advantage of its native txn simulation
    // safety features
    const multicallerClient = new MultiCallerClient(logger);
    let txnHashLookup: Record<number, string[]> = {};
    try {
      const finalizationsByChain = groupBy(
        finalizations,
        ({ crossChainMessage }) => crossChainMessage.destinationChainId
      );
      for (const [chainId, finalizations] of Object.entries(finalizationsByChain)) {
        const finalizerTxns = finalizations.map(({ txn }) => txn);
        const txnToSubmit: AugmentedTransaction = {
          contract: multicall2Lookup[Number(chainId)],
          chainId: Number(chainId),
          method: "aggregate",
          args: [finalizerTxns],
          gasLimit: gasEstimation,
          gasLimitMultiplier: 2,
          unpermissioned: true,
          message: `Batch finalized ${finalizerTxns.length} txns`,
          mrkdwn: `Batch finalized ${finalizerTxns.length} txns`,
        };
        multicallerClient.enqueueTransaction(txnToSubmit);
      }
      txnHashLookup = await multicallerClient.executeTxnQueues(!submitFinalizationTransactions);
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
        transactionHashList: txnHashLookup[destinationChainId]?.map((txnHash) =>
          blockExplorerLink(txnHash, destinationChainId)
        ),
      });
    });
    transfers.forEach(
      ({ crossChainMessage: { originationChainId, destinationChainId, type, amount, l1TokenSymbol: symbol } }) => {
        const originationNetwork = getNetworkName(originationChainId);
        const destinationNetwork = getNetworkName(destinationChainId);
        logger.info({
          at: "Finalizer",
          message: `Finalized ${originationNetwork} ${type} on ${destinationNetwork} for ${amount} ${symbol} 🪃`,
          transactionHashList: txnHashLookup[destinationChainId]?.map((txnHash) =>
            blockExplorerLink(txnHash, destinationChainId)
          ),
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

  // Construct spoke pool clients for all chains that are not *currently* disabled. Caller can override
  // the disabled chain list by setting the DISABLED_CHAINS_OVERRIDE environment variable.
  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.hubPoolClient,
    commonClients.configStoreClient,
    config,
    baseSigner,
    config.maxFinalizerLookback
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
  readonly addressesToMonitorForL1L2Finalizer: string[];
  readonly finalizationStrategy: FinalizationType;

  constructor(env: ProcessEnv) {
    const { FINALIZER_MAX_TOKENBRIDGE_LOOKBACK, FINALIZER_CHAINS, L1_L2_FINALIZER_MONITOR_ADDRESS } = env;
    super(env);

    this.chainsToFinalize = JSON.parse(FINALIZER_CHAINS ?? "[]");
    this.addressesToMonitorForL1L2Finalizer = JSON.parse(L1_L2_FINALIZER_MONITOR_ADDRESS ?? "[]").map(getAddress);

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

  logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer started 🏋🏿‍♀️", config });
  const { commonClients, spokePoolClients } = await constructFinalizerClients(logger, config, baseSigner);

  try {
    for (;;) {
      const loopStart = performance.now();
      await updateSpokePoolClients(spokePoolClients, ["TokensBridged"]);
      const loopStartPostSpokePoolUpdates = performance.now();

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
          config.addressesToMonitorForL1L2Finalizer,
          config.sendingFinalizationsEnabled,
          config.finalizationStrategy
        );
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Finalizer disabled" });
      }
      const loopEndPostFinalizations = performance.now();

      logger.debug({
        at: "Finalizer#index",
        message: `Time to loop: ${Math.round((loopEndPostFinalizations - loopStart) / 1000)}s`,
        timeToUpdateSpokeClients: Math.round((loopStartPostSpokePoolUpdates - loopStart) / 1000),
        timeToFinalize: Math.round((loopEndPostFinalizations - loopStartPostSpokePoolUpdates) / 1000),
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
