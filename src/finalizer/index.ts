import { processCrash, processEndPollingLoop, startupLogLevel, Wallet } from "../utils";
import { getProvider, getSigner, winston } from "../utils";
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
import { constructFinalizerClients, FinalizerClients, updateFinalizerClients } from "./FinalizerClientHelper";
let logger: winston.Logger;

export async function run(
  logger: winston.Logger,
  hubSigner: Wallet,
  clients: FinalizerClients,
  configuredChainIds: number[],
  sendingTransactionsEnabled: boolean
): Promise<void> {
  const spokePoolClients = clients.spokePoolClients;
  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];
    const tokensBridged = client.getTokensBridged();

    if (chainId === 42161) {
      const finalizableMessages = await getFinalizableMessages(logger, tokensBridged, hubSigner, clients.hubPoolClient);
      for (const l2Message of finalizableMessages) {
        await finalizeArbitrum(
          logger,
          l2Message.message,
          l2Message.proofInfo,
          l2Message.info,
          clients.hubPoolClient,
          clients.multiCallerClient
        );
      }
    } else if (chainId === 137) {
      const posClient = await getPosClient(hubSigner);
      const canWithdraw = await getFinalizableTransactions(logger, tokensBridged, posClient, clients.hubPoolClient);
      for (const event of canWithdraw) {
        await finalizePolygon(posClient, clients.hubPoolClient, event, logger, clients.multiCallerClient);
      }
      for (const l2Token of getL2TokensToFinalize(tokensBridged)) {
        await retrieveTokenFromMainnetTokenBridger(
          logger,
          l2Token,
          hubSigner,
          clients.hubPoolClient,
          clients.multiCallerClient
        );
      }
    } else if (chainId === 10) {
      const crossChainMessenger = getOptimismClient(hubSigner);
      const finalizableMessages = await getOptimismFinalizableMessages(logger, tokensBridged, crossChainMessenger);
      for (const message of finalizableMessages) {
        await finalizeOptimismMessage(
          clients.hubPoolClient,
          clients.multiCallerClient,
          crossChainMessenger,
          message,
          logger
        );
      }
    }
  }

  await clients.multiCallerClient.executeTransactionQueue(!sendingTransactionsEnabled);
}

export async function runFinalizer(_logger: winston.Logger) {
  logger = _logger;

  const config = new FinalizerConfig(process.env);
  const baseSigner = await getSigner();
  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const clients = await constructFinalizerClients(logger, config);

  try {
    logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer started ⚰️", config });

    for (;;) {
      await updateFinalizerClients(clients);

      // Validate and dispute pending proposal before proposing a new one
      if (config.finalizerEnabled)
        await run(logger, hubSigner, clients, config.finalizerChains, config.sendingTransactionsEnabled);
      else logger.debug({ at: "Finalizer#index", message: "Finalizer disabled" });

      if (await processEndPollingLoop(logger, "Finalizer", config.pollingDelay)) break;
    }
  } catch (error) {
    if (await processCrash(logger, "Finalizer", config.pollingDelay, error)) process.exit(1);
    await runFinalizer(logger);
  }
}
