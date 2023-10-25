import assert from "assert";
import { typeguards, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { providers } from "ethers";
import { groupBy } from "lodash";
import {
  Wallet,
  config,
  startupLogLevel,
  processEndPollingLoop,
  getNetworkName,
  blockExplorerLink,
  getBlockForTimestamp,
  getCurrentTime,
  disconnectRedisClients,
  getMultisender,
  winston,
} from "../utils";
import { arbitrumOneFinalizer, opStackFinalizer, polygonFinalizer, zkSyncFinalizer } from "./utils";
import { SpokePoolClientsByChain } from "../interfaces";
import { HubPoolClient } from "../clients";
import { DataworkerConfig } from "../dataworker/DataworkerConfig";
import {
  constructClients,
  constructSpokePoolClientsWithLookback,
  updateSpokePoolClients,
  Clients,
  ProcessEnv,
  FINALIZER_TOKENBRIDGE_LOOKBACK,
  Multicall2Call,
} from "../common";
import { ChainFinalizer, Withdrawal } from "./types";

type TransactionReceipt = providers.TransactionReceipt;

const { isError, isEthersError } = typeguards;
const { isDefined } = sdkUtils;

config();
let logger: winston.Logger;

// Filter for optimistic rollups
const oneDaySeconds = 24 * 60 * 60;

const chainFinalizers: { [chainId: number]: ChainFinalizer } = {
  10: opStackFinalizer,
  137: polygonFinalizer,
  280: zkSyncFinalizer,
  324: zkSyncFinalizer,
  8453: opStackFinalizer,
  42161: arbitrumOneFinalizer,
};

export async function finalize(
  logger: winston.Logger,
  hubSigner: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  configuredChainIds: number[],
  optimisticRollupFinalizationWindow: number = 5 * oneDaySeconds,
  polygonFinalizationWindow: number = oneDaySeconds
): Promise<void> {
  const finalizationWindows: { [chainId: number]: number } = {
    10: optimisticRollupFinalizationWindow,
    137: polygonFinalizationWindow,
    280: oneDaySeconds * 8,
    324: oneDaySeconds * 4,
    8453: optimisticRollupFinalizationWindow,
    42161: optimisticRollupFinalizationWindow,
  };

  const hubChainId = hubPoolClient.chainId;
  const hubChain = getNetworkName(hubChainId);

  // Note: Could move this into a client in the future to manage # of calls and chunk calls based on
  // input byte length.
  const multicall2 = getMultisender(hubChainId, hubSigner);
  const finalizationsToBatch: { txn: Multicall2Call; withdrawal?: Withdrawal }[] = [];

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

    const chainFinalizer = chainFinalizers[chainId];
    assert(chainFinalizer !== undefined, `No withdrawal finalizer available for chain ${chainId}`);

    const finalizationWindow = finalizationWindows[chainId];
    assert(finalizationWindow !== undefined, `No finalization window defined for chain ${chainId}`);

    const latestBlockToFinalize = await getBlockForTimestamp(chainId, getCurrentTime() - finalizationWindow);

    const network = getNetworkName(chainId);
    logger.debug({ at: "finalize", message: `Spawning ${network} finalizer.`, latestBlockToFinalize });
    const { callData, withdrawals } = await chainFinalizer(
      logger,
      hubSigner,
      hubPoolClient,
      client,
      latestBlockToFinalize
    );

    callData.forEach((txn, idx) => {
      finalizationsToBatch.push({ txn, withdrawal: withdrawals[idx] });
    });
    logger.debug({
      at: "finalize",
      message: `Found ${withdrawals.length} ${network} withdrawals for finalization.`,
    });
  }

  // Ensure each transaction would succeed in isolation.
  const finalizations = await sdkUtils.filterAsync(finalizationsToBatch, async ({ txn: _txn, withdrawal }) => {
    try {
      const txn = await multicall2.populateTransaction.aggregate([_txn]);
      await multicall2.provider.estimateGas(txn);
      return true;
    } catch (err) {
      const reason = isEthersError(err) ? err.reason : isError(err) ? err.message : "unknown error";
      let message: string;

      if (isDefined(withdrawal)) {
        const { l2ChainId, type, l1TokenSymbol, amount } = withdrawal;
        const network = getNetworkName(l2ChainId);
        message = `Failed to estimate gas for ${network} ${amount} ${l1TokenSymbol} ${type}.`;
      } else {
        // @dev Likely to be the 2nd part of a 2-stage withdrawal (i.e. retrieve() on the Polygon bridge adapter).
        message = "Unknown finalizer simulation failure.";
      }
      logger.info({ at: "finalizer", message, reason, txn: _txn });
      return false;
    }
  });

  if (finalizations.length > 0) {
    let txn: TransactionReceipt;
    try {
      // Note: If the sum of finalizations approaches the gas limit, consider slicing them up.
      const txns = finalizations.map(({ txn }) => txn);
      txn = await (await multicall2.aggregate(txns)).wait();
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

    const { withdrawals = [], proofs = [] } = groupBy(
      finalizations.filter(({ withdrawal }) => isDefined(withdrawal)),
      ({ withdrawal: { type } }) => {
        return type === "withdrawal" ? "withdrawals" : "proofs";
      }
    );

    proofs.forEach(({ withdrawal: { l2ChainId, amount, l1TokenSymbol: symbol } }) => {
      const spokeChain = getNetworkName(l2ChainId);
      logger.info({
        at: "Finalizer",
        message: `Submitted proof on chain ${hubChain} to initiate ${spokeChain} withdrawal of ${amount} ${symbol} 🔜`,
        transactionHash: blockExplorerLink(txn.transactionHash, hubChainId),
      });
    });
    withdrawals.forEach(({ withdrawal: { l2ChainId, amount, l1TokenSymbol: symbol } }) => {
      const spokeChain = getNetworkName(l2ChainId);
      logger.info({
        at: "Finalizer",
        message: `Finalized ${spokeChain} withdrawal for ${amount} ${symbol} 🪃`,
        transactionHash: blockExplorerLink(txn.transactionHash, hubChainId),
      });
    });
  }
}

export async function constructFinalizerClients(
  _logger: winston.Logger,
  config: FinalizerConfig,
  baseSigner: Wallet
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

export async function runFinalizer(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
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
            : commonClients.configStoreClient.getChainIdIndicesForBlock()
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
