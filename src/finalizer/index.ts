// NOTE: The "finalizers/" directory structure is just a strawman and is expected to change.
import { delay, Logger } from "../utils";
import { getProvider, getSigner, winston } from "../utils";
import { constructClients, updateClients, updateSpokePoolClients } from "../common";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { constructSpokePoolClientsWithLookback } from "../relayer/RelayerClientHelper";
import {
  finalizeArbitrum,
  finalizePolygon,
  getFinalizableMessages,
  getFinalizableTransactions,
  getL2TokensToFinalize,
  getPosClient,
  retrieveTokenFromMainnetTokenBridger,
} from "./utils";

// How to run:
// - Set same config you'd need to relayer in terms of L2 node urls
// - ts-node ./src/finalizer/index.ts --wallet mnemonic

export async function run(logger: winston.Logger, config: RelayerConfig): Promise<void> {
  // Common set up with Dataworker/Relayer client helpers, can we refactor?
  const baseSigner = await getSigner();
  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const commonClients = await constructClients(logger, config);
  const spokePoolClients = await constructSpokePoolClientsWithLookback(logger, commonClients, config, baseSigner);

  await updateClients(commonClients);
  await updateSpokePoolClients(spokePoolClients);

  // TODO: Load chain ID's from config
  const configuredChainIds = [137, 42161];

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
        commonClients.hubPoolClient
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
      const canWithdraw = await getFinalizableTransactions(tokensBridged, posClient, commonClients.hubPoolClient);
      if (canWithdraw.length === 0)
        logger.debug({
          at: "PolygonFinalizer",
          message: "No finalizable messages, will check for retrievals from token bridge",
        });
      for (const event of canWithdraw) {
        await finalizePolygon(posClient, commonClients.hubPoolClient, event, logger);
      }
      for (const l2Token of getL2TokensToFinalize(tokensBridged)) {
        await retrieveTokenFromMainnetTokenBridger(logger, l2Token, hubSigner, commonClients.hubPoolClient);
      }
    }
  }
}

// Refactor below to external index.ts entrypoint
if (require.main === module) {
  const config = new RelayerConfig(process.env);
  const logger = Logger;
  run(logger, config)
    .then(() => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.error(error);
      logger.error({
        at: "InfrastructureEntryPoint",
        message: "There was an error in the main entry point!",
        error,
        notificationPath: "across-error",
      });
      await delay(5);
      await run(logger, config);
    });
}
