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

    if (chainId === 42161) {
      logger.debug({
        at: "ArbitrumFinalizer",
        message: "Looking for finalizable bridge events",
      });
      const finalizableMessages = await getFinalizableMessages(
        logger,
        tokensBridged,
        hubSigner,
        relayerClients.hubPoolClient
      );
      for (const l2Message of finalizableMessages) {
        await finalizeArbitrum(logger, l2Message.message, l2Message.token, l2Message.proofInfo);
      }
    } else if (chainId === 137) {
      logger.debug({
        at: "PolygonFinalizer",
        message: "Looking for finalizable bridge events",
      });
      const posClient = await getPosClient(hubSigner);
      const canWithdraw = await getFinalizableTransactions(tokensBridged, posClient, relayerClients.hubPoolClient);
      if (canWithdraw.length === 0)
        logger.debug({
          at: "PolygonFinalizer",
          message: "No finalizable messages, will check for retrievals from token bridge",
        });
      for (const event of canWithdraw) {
        await finalizePolygon(posClient, relayerClients.hubPoolClient, event, logger);
      }
      for (const l2Token of getL2TokensToFinalize(tokensBridged)) {
        await retrieveTokenFromMainnetTokenBridger(logger, l2Token, hubSigner, relayerClients.hubPoolClient);
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
    await updateRelayerClients(relayerClients);

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
