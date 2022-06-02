import { processEndPollingLoop, winston, config, startupLogLevel, processCrash, getSigner } from "../utils";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  updateDataworkerClients,
  spokePoolClientsToProviders,
} from "./DataworkerClientHelper";
import { updateSpokePoolClients, constructSpokePoolClientsWithLookback, SpokePoolClientsByChain } from "../common";
import { BalanceAllocator } from "../clients/BalanceAllocator";
config();
let logger: winston.Logger;

export async function createDataworker(_logger: winston.Logger) {
  const config = new DataworkerConfig(process.env);
  const clients = await constructDataworkerClients(_logger, config);

  const dataworker = new Dataworker(
    _logger,
    clients,
    Constants.CHAIN_ID_LIST_INDICES,
    config.maxRelayerRepaymentLeafSizeOverride,
    config.maxPoolRebalanceLeafSizeOverride,
    config.tokenTransferThresholdOverride,
    config.blockRangeEndBlockBuffer,
    config.spokeRootsLookbackCount
  );

  return {
    config,
    clients,
    dataworker,
  };
}

// Should refactor most of this file + DataworkerClientHelper to reuse more code from ClientHelper and
// RelayerClientHelper
export async function runDataworker(_logger: winston.Logger): Promise<void> {
  logger = _logger;
  const { clients, config, dataworker } = await createDataworker(logger);
  const baseSigner = await getSigner();
  let spokePoolClients: SpokePoolClientsByChain;
  try {
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    for (;;) {
      // Clear cache so results can be updated with new data.
      dataworker.clearCache();
      await updateDataworkerClients(clients);
      if (spokePoolClients === undefined)
        spokePoolClients = await constructSpokePoolClientsWithLookback(logger, clients, config, baseSigner);
      await updateSpokePoolClients(spokePoolClients);

      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled) await dataworker.validatePendingRootBundle(spokePoolClients);
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });

      if (config.proposerEnabled)
        await dataworker.proposeRootBundle(spokePoolClients, config.rootBundleExecutionThreshold);
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });

      if (config.executorEnabled) {
        const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

        await dataworker.executePoolRebalanceLeaves(spokePoolClients, balanceAllocator);

        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves(spokePoolClients, balanceAllocator);
        await dataworker.executeRelayerRefundLeaves(spokePoolClients, balanceAllocator);
      } else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });

      await clients.multiCallerClient.executeTransactionQueue(!config.sendingTransactionsEnabled);

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    if (await processCrash(logger, "Dataworker", config.pollingDelay, error)) process.exit(1);
    await runDataworker(logger);
  }
}
