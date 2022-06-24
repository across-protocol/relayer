import { Wallet, config, startupLogLevel, processEndPollingLoop, processCrash, getSigner } from "../utils";
import { winston } from "../utils";
import {
  finalizeArbitrum,
  finalizePolygon,
  getFinalizableMessages,
  getFinalizableTransactions,
  getL2TokensToFinalize,
  getPosClient,
  retrieveTokenFromMainnetTokenBridger,
  getOptimismClient,
  getOptimismFinalizableMessages,
  finalizeOptimismMessage,
} from "./utils";
import { SpokePoolClientsByChain } from "../interfaces";
import { HubPoolClient } from "../clients";
import { DataworkerConfig } from "../dataworker/DataworkerConfig";
import {
  constructClients,
  constructSpokePoolClientsWithLookback,
  updateClients,
  updateSpokePoolClients,
} from "../common";
config();
let logger: winston.Logger;

export async function finalize(
  logger: winston.Logger,
  hubSigner: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  configuredChainIds: number[]
): Promise<void> {
  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];
    const tokensBridged = client.getTokensBridged();

    if (chainId === 42161) {
      const finalizableMessages = await getFinalizableMessages(logger, tokensBridged, hubSigner);
      for (const l2Message of finalizableMessages) {
        await finalizeArbitrum(logger, l2Message.message, l2Message.proofInfo, l2Message.info, hubPoolClient);
      }
    } else if (chainId === 137) {
      const posClient = await getPosClient(hubSigner);
      const canWithdraw = await getFinalizableTransactions(logger, tokensBridged, posClient, hubPoolClient);
      for (const event of canWithdraw) {
        await finalizePolygon(posClient, hubPoolClient, event, logger);
      }
      for (const l2Token of getL2TokensToFinalize(tokensBridged)) {
        await retrieveTokenFromMainnetTokenBridger(logger, l2Token, hubSigner, hubPoolClient);
      }
    } else if (chainId === 10) {
      const crossChainMessenger = getOptimismClient(hubSigner);
      const finalizableMessages = await getOptimismFinalizableMessages(logger, tokensBridged, crossChainMessenger);
      for (const message of finalizableMessages) {
        await finalizeOptimismMessage(hubPoolClient, crossChainMessenger, message, logger);
      }
    }
  }
}

export async function constructFinalizerClients(_logger: winston.Logger, config) {
  const baseSigner = await getSigner();

  const commonClients = await constructClients(_logger, config);

  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.configStoreClient,
    config,
    baseSigner,
    {} // We don't override the lookback as we want to look up all TokensBridged events.
  );

  return {
    commonClients,
    spokePoolClients,
  };
}

export async function runFinalizer(_logger: winston.Logger): Promise<void> {
  logger = _logger;
  // Same config as Dataworker for now.
  const config = new DataworkerConfig(process.env);

  const { commonClients, spokePoolClients } = await constructFinalizerClients(logger, config);

  try {
    logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer started 🏋🏿‍♀️", config });

    for (;;) {
      await updateClients(commonClients);
      await updateSpokePoolClients(spokePoolClients, ["TokensBridged", "EnabledDepositRoute"]);

      if (config.finalizerEnabled)
        await finalize(
          logger,
          commonClients.hubSigner,
          commonClients.hubPoolClient,
          spokePoolClients,
          config.finalizerChains
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Finalizer disabled" });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    if (await processCrash(logger, "Dataworker", config.pollingDelay, error)) process.exit(1);
    await runFinalizer(logger);
  }
}
