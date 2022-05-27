import { groupObjectCountsByTwoProps, processCrash, processEndPollingLoop, startupLogLevel, Wallet } from "../utils";
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
  getCrossChainMessages,
  getMessageStatuses,
  getOptimismFinalizableMessages,
} from "./utils";
import { FinalizerConfig } from "./FinalizerConfig";
let logger: winston.Logger;

export async function run(
  logger: winston.Logger,
  hubSigner: Wallet,
  relayerClients: RelayerClients,
  configuredChainIds: number[]
): Promise<void> {
  const spokePoolClients = relayerClients.spokePoolClients;
  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];
    const tokensBridged = client.getTokensBridged();

    logger.debug({
      at: "Finalizer",
      message: `Looking for finalizable bridge events for chain ${chainId}`,
    });
    // TODO: Refactor following code to produce list of transaction call data we can submit together in a single
    // batch to a DS proxy or multi call contract.
    if (chainId === 42161) {
      const finalizableMessages = await getFinalizableMessages(
        logger,
        tokensBridged,
        hubSigner,
        relayerClients.hubPoolClient
      );
      for (const l2Message of finalizableMessages) {
        await finalizeArbitrum(
          logger,
          l2Message.message,
          l2Message.token,
          l2Message.proofInfo,
          l2Message.info,
          relayerClients.hubPoolClient
        );
      }
    } else if (chainId === 137) {
      const posClient = await getPosClient(hubSigner);
      const canWithdraw = await getFinalizableTransactions(tokensBridged, posClient, relayerClients.hubPoolClient);
      if (canWithdraw.length === 0)
        logger.debug({
          at: "PolygonFinalizer",
          message: `No Polygon finalizable messages, will check for retrievals from token bridge`,
        });
      for (const event of canWithdraw) {
        await finalizePolygon(posClient, relayerClients.hubPoolClient, event, logger);
      }
      for (const l2Token of getL2TokensToFinalize(tokensBridged)) {
        await retrieveTokenFromMainnetTokenBridger(logger, l2Token, hubSigner, relayerClients.hubPoolClient);
      }
    } else if (chainId === 10) {
      const crossChainMessenger = getOptimismClient(hubSigner);
      const crossChainMessages = await getCrossChainMessages(
        tokensBridged,
        relayerClients.hubPoolClient,
        crossChainMessenger
      );
      const messageStatuses = await getMessageStatuses(crossChainMessages, crossChainMessenger);
      logger.debug({
        at: "OptimismFinalizer",
        message: "Optimism message statuses",
        statusesGrouped: groupObjectCountsByTwoProps(messageStatuses, "status", (message) => message["token"]),
      });
      const finalizable = getOptimismFinalizableMessages(messageStatuses);
      if (finalizable.length === 0)
        logger.debug({
          at: "OptimismFinalizer",
          message: "No Optimism finalizable messages",
        });
      for (const message of finalizable) {
        logger.debug({
          at: "OptimismFinalizer",
          message: "Finalizing Optimism message",
          l1Token: message.token,
        });
        await crossChainMessenger.finalizeMessage(message.message);
        logger.info({
          at: "OptimismFinalizer",
          message: "Finalized Optimism message!",
          l1Token: message.token,
          // TODO: Add amount log
        });
      }
    }
  }
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
      if (config.finalizerEnabled) await run(logger, hubSigner, relayerClients, config.finalizerChains);
      else logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer disabled" });

      if (await processEndPollingLoop(logger, "Finalizer", config.pollingDelay)) break;
    }
  } catch (error) {
    if (await processCrash(logger, "Finalizer", config.pollingDelay, error)) process.exit(1);
    await runFinalizer(logger);
  }
}
