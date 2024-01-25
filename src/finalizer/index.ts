import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import assert from "assert";
import { BigNumber, Contract, constants } from "ethers";
import { groupBy, uniq } from "lodash";
import { AugmentedTransaction, HubPoolClient, MultiCallerClient, TransactionClient } from "../clients";
import {
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
  getBlockForTimestamp,
  getCurrentTime,
  getMultisender,
  getNetworkName,
  getRedisCache,
  processEndPollingLoop,
  startupLogLevel,
  winston,
} from "../utils";
import { ChainFinalizer, CrossChainTransfer } from "./types";
import {
  arbitrumOneFinalizer,
  cctpL1toL2Finalizer,
  cctpL2toL1Finalizer,
  opStackFinalizer,
  polygonFinalizer,
  scrollFinalizer,
  zkSyncFinalizer,
} from "./utils";
const { isDefined } = sdkUtils;

config();
let logger: winston.Logger;

// Filter for optimistic rollups
const oneDaySeconds = 24 * 60 * 60;
const oneHourSeconds = 60 * 60;

const chainFinalizers: { [chainId: number]: ChainFinalizer } = {
  10: opStackFinalizer,
  137: polygonFinalizer,
  280: zkSyncFinalizer,
  324: zkSyncFinalizer,
  8453: opStackFinalizer,
  42161: arbitrumOneFinalizer,
  534352: scrollFinalizer,
};

/**
 * A list of finalizers that should be run for each chain. Note: we do this
 * because some chains have multiple finalizers that need to be run.
 * Mainly related to CCTP.
 */
const chainFinalizerOverrides: { [chainId: number]: ChainFinalizer[] } = {
  // Mainnets
  10: [opStackFinalizer, cctpL1toL2Finalizer, cctpL2toL1Finalizer],
  137: [polygonFinalizer, cctpL1toL2Finalizer, cctpL2toL1Finalizer],
  8453: [opStackFinalizer, cctpL1toL2Finalizer, cctpL2toL1Finalizer],
  42161: [arbitrumOneFinalizer, cctpL1toL2Finalizer, cctpL2toL1Finalizer],
  // Testnets
  84532: [cctpL1toL2Finalizer, cctpL2toL1Finalizer],
};

export async function finalize(
  logger: winston.Logger,
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  configuredChainIds: number[],
  submitFinalizationTransactions: boolean,
  optimisticRollupFinalizationWindow = 5 * oneDaySeconds,
  polygonFinalizationWindow = 5 * oneDaySeconds
): Promise<void> {
  const finalizationWindows: { [chainId: number]: number } = {
    // Mainnets
    10: optimisticRollupFinalizationWindow, // Optimism Mainnet
    137: polygonFinalizationWindow, // Polygon Mainnet
    324: oneDaySeconds * 4, // zkSync Mainnet
    8453: optimisticRollupFinalizationWindow, // Base Mainnet
    42161: optimisticRollupFinalizationWindow, // Arbitrum One Mainnet
    534352: oneHourSeconds * 4, // Scroll Mainnet

    // Testnets
    534351: oneHourSeconds * 4, // Scroll Sepolia
    84532: optimisticRollupFinalizationWindow, // Base Testnet (Sepolia)
    280: oneDaySeconds * 8, // zkSync Goerli
    59144: oneHourSeconds * 12, // Linea Mainnet
    59140: oneHourSeconds * 12, // Linea Goerli
  };

  const hubChainId = hubPoolClient.chainId;

  // Note: Could move this into a client in the future to manage # of calls and chunk calls based on
  // input byte length.
  const finalizationsToBatch: { txn: Multicall2Call; crossChainTransfer?: CrossChainTransfer }[] = [];

  // For each chain, delegate to a handler to look up any TokensBridged events and attempt finalization.
  for (const chainId of configuredChainIds) {
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
      continue;
    }

    // We want to first resolve a possible override for the finalizer, and
    // then fallback to the default finalizer.
    const chainSpecificFinalizers = (chainFinalizerOverrides[chainId] ?? [chainFinalizers[chainId]]).filter(isDefined);
    assert(chainSpecificFinalizers?.length > 0, `No finalizer available for chain ${chainId}`);

    const finalizationWindow = finalizationWindows[chainId];
    assert(finalizationWindow !== undefined, `No finalization window defined for chain ${chainId}`);

    const lookback = getCurrentTime() - finalizationWindow;
    const blockFinder = undefined;
    const redis = await getRedisCache(logger);
    const latestBlockToFinalize = await getBlockForTimestamp(chainId, lookback, blockFinder, redis);

    const network = getNetworkName(chainId);
    logger.debug({ at: "finalize", message: `Spawning ${network} finalizer.`, latestBlockToFinalize });

    // We can subloop through the finalizers for each chain, and then execute the finalizer. For now, the
    // main reason for this is related to CCTP finalizations. We want to run the CCTP finalizer AND the
    // normal finalizer for each chain. This is going to cause an overlap of finalization attempts on USDC.
    // However, that's okay because each finalizer will only attempt to finalize the messages that it is
    // responsible for.
    let totalWithdrawalsForChain = 0;
    let totalDepositsForChain = 0;
    let totalMiscTxnsForChain = 0;
    for (const finalizer of chainSpecificFinalizers) {
      const { callData, crossChainTransfers } = await finalizer(
        logger,
        hubSigner,
        hubPoolClient,
        client,
        latestBlockToFinalize
      );

      callData.forEach((txn, idx) => {
        finalizationsToBatch.push({ txn, crossChainTransfer: crossChainTransfers[idx] });
      });

      totalWithdrawalsForChain += crossChainTransfers.filter(({ type }) => type === "withdrawal").length;
      totalDepositsForChain += crossChainTransfers.filter(({ type }) => type === "deposit").length;
      totalMiscTxnsForChain += crossChainTransfers.filter(({ type }) => type === "misc").length;
    }
    logger.debug({
      at: "finalize",
      message: `Found ${totalWithdrawalsForChain} ${network} transfers (${totalWithdrawalsForChain} withdrawals | ${totalDepositsForChain} deposits | ${totalMiscTxnsForChain} supporting txns ) for finalization.`,
    });
  }
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
  const finalizations = await sdkUtils.filterAsync(finalizationsToBatch, async ({ txn: _txn, crossChainTransfer }) => {
    const txnToSubmit: AugmentedTransaction = {
      contract: multicall2Lookup[crossChainTransfer.destinationChainId],
      chainId: crossChainTransfer.destinationChainId,
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
    if (isDefined(crossChainTransfer)) {
      const { originationChainId, destinationChainId, type, l1TokenSymbol, amount } = crossChainTransfer;
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
        ({ crossChainTransfer }) => crossChainTransfer.destinationChainId
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
      finalizations.filter(({ crossChainTransfer }) => isDefined(crossChainTransfer)),
      ({ crossChainTransfer: { type } }) => {
        return type === "misc" ? "misc" : "transfers";
      }
    );

    misc.forEach(({ crossChainTransfer }) => {
      const { originationChainId, destinationChainId, amount, l1TokenSymbol: symbol, type } = crossChainTransfer;
      // Required for tsc to be happy.
      if (type !== "misc") {
        return;
      }
      const { miscReason } = crossChainTransfer;
      const originationNetwork = getNetworkName(originationChainId);
      const destinationNetwork = getNetworkName(destinationChainId);
      logger.info({
        at: "Finalizer",
        message: `Submitted ${miscReason} on ${destinationNetwork} to support a ${originationNetwork} withdrawal of ${amount} ${symbol} 🔜`,
        transactionHashList: txnHashLookup[destinationChainId]?.map((txnHash) =>
          blockExplorerLink(txnHash, destinationChainId)
        ),
      });
    });
    transfers.forEach(
      ({ crossChainTransfer: { originationChainId, destinationChainId, type, amount, l1TokenSymbol: symbol } }) => {
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
  const commonClients = await constructClients(_logger, config, baseSigner);
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

  constructor(env: ProcessEnv) {
    const { FINALIZER_MAX_TOKENBRIDGE_LOOKBACK } = env;
    super(env);

    // `maxFinalizerLookback` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxFinalizerLookback = Number(FINALIZER_MAX_TOKENBRIDGE_LOOKBACK ?? FINALIZER_TOKENBRIDGE_LOOKBACK);
    assert(
      Number.isInteger(this.maxFinalizerLookback),
      `Invalid FINALIZER_MAX_TOKENBRIDGE_LOOKBACK: ${FINALIZER_MAX_TOKENBRIDGE_LOOKBACK}`
    );
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
      const loopStart = Date.now();
      await updateSpokePoolClients(spokePoolClients, ["TokensBridged", "EnabledDepositRoute"]);

      if (config.finalizerEnabled) {
        await finalize(
          logger,
          commonClients.hubSigner,
          commonClients.hubPoolClient,
          spokePoolClients,
          process.env.FINALIZER_CHAINS
            ? JSON.parse(process.env.FINALIZER_CHAINS)
            : commonClients.configStoreClient.getChainIdIndicesForBlock(),
          config.sendingFinalizationsEnabled
        );
      } else {
        logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Finalizer disabled" });
      }

      logger.debug({ at: "Finalizer#index", message: `Time to loop: ${(Date.now() - loopStart) / 1000}s` });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) {
        break;
      }
    }
  } finally {
    await disconnectRedisClients(logger);
  }
}
