import { sortEventsDescending, Wallet } from "../utils";
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
import { SpokePoolClientsByChain, TokensBridged } from "../interfaces";
import { HubPoolClient } from "../clients";

export async function finalize(
  logger: winston.Logger,
  hubSigner: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  configuredChainIds: number[],
  bridgeEventsToLookup = 200
): Promise<void> {
  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];

    // Cap number of events we look up since each chain might make async calls to fetch data to parse each
    // withdrawal event status.
    const tokensBridged: TokensBridged[] = sortEventsDescending(client.getTokensBridged()).slice(
      0,
      bridgeEventsToLookup // TODO: Parameterize this magic number
    );

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
