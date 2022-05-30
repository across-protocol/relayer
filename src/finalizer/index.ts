import { processCrash, processEndPollingLoop, startupLogLevel, Wallet } from "../utils";
import { getProvider, getSigner, winston } from "../utils";
import { constructRelayerClients, RelayerClients, updateRelayerClients } from "../relayer/RelayerClientHelper";
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
import { FinalizerConfig } from "./FinalizerConfig";
let logger: winston.Logger;

export async function run(
  logger: winston.Logger,
  hubSigner: Wallet,
  relayerClients: RelayerClients,
  configuredChainIds: number[],
  sendingTransactionsEnabled: boolean
): Promise<void> {
  const spokePoolClients = relayerClients.spokePoolClients;
  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];
    const tokensBridged = client.getTokensBridged();

    if (chainId === 42161) {
      const finalizableMessages = await getFinalizableMessages(
        logger,
        tokensBridged,
        hubSigner,
        relayerClients.hubPoolClient
      );
      logger.debug({
        at: "ArbitrumFinalizer",
        message: `Found ${finalizableMessages.length} finalizable messages from chain ${chainId}`,
      });
      for (const l2Message of finalizableMessages) {
        await finalizeArbitrum(
          logger,
          l2Message.message,
          l2Message.token,
          l2Message.proofInfo,
          l2Message.info,
          relayerClients.hubPoolClient,
          relayerClients.multiCallerClient
        );
      }
    } else if (chainId === 137) {
      const posClient = await getPosClient(hubSigner);
      const canWithdraw = await getFinalizableTransactions(tokensBridged, posClient, relayerClients.hubPoolClient);
      logger.debug({
        at: "PolygonFinalizer",
        message: `Found ${canWithdraw.length} finalizable messages from chain ${chainId}`,
      });
      for (const event of canWithdraw) {
        await finalizePolygon(posClient, relayerClients.hubPoolClient, event, logger, relayerClients.multiCallerClient);
      }
      for (const l2Token of getL2TokensToFinalize(tokensBridged)) {
        await retrieveTokenFromMainnetTokenBridger(
          logger,
          l2Token,
          hubSigner,
          relayerClients.hubPoolClient,
          relayerClients.multiCallerClient
        );
      }
    } else if (chainId === 10) {
      const crossChainMessenger = getOptimismClient(hubSigner);
      const finalizableMessages = await getOptimismFinalizableMessages(
        logger,
        tokensBridged,
        relayerClients.hubPoolClient,
        crossChainMessenger
      );
      logger.debug({
        at: "OptimismFinalizer",
        message: `Found ${finalizableMessages.length} finalizable messages from chain ${chainId}`,
      });
      for (const message of finalizableMessages) {
        finalizeOptimismMessage(relayerClients.multiCallerClient, crossChainMessenger, message, logger);
      }
    }
  }

  await relayerClients.multiCallerClient.executeTransactionQueue(!sendingTransactionsEnabled);
}

export async function runFinalizer(_logger: winston.Logger) {
  logger = _logger;

  const config = new FinalizerConfig(process.env);
  const baseSigner = await getSigner();
  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const relayerClients = await constructRelayerClients(logger, config);

  try {
    logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer started ⚰️", config });

    for (;;) {
      await updateRelayerClients(relayerClients);

      // Validate and dispute pending proposal before proposing a new one
      if (config.finalizerEnabled)
        await run(logger, hubSigner, relayerClients, config.finalizerChains, config.sendingTransactionsEnabled);
      else logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer disabled" });

      if (await processEndPollingLoop(logger, "Finalizer", config.pollingDelay)) break;
    }
  } catch (error) {
    if (await processCrash(logger, "Finalizer", config.pollingDelay, error)) process.exit(1);
    await runFinalizer(logger);
  }
}
