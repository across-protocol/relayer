import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { processEndPollingLoop, winston, config, startupLogLevel, Signer, disconnectRedisClients } from "../utils";
import { Relayer } from "./Relayer";
import { RelayerConfig } from "./RelayerConfig";
import { constructRelayerClients, RelayerClients, updateRelayerClients } from "./RelayerClientHelper";
config();
let logger: winston.Logger;

export async function runRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new RelayerConfig(process.env);
  let relayerClients: RelayerClients;

  try {
    logger[startupLogLevel(config)]({ at: "Relayer#index", message: "Relayer started 🏃‍♂️", config });

    relayerClients = await constructRelayerClients(logger, config, baseSigner);
    const { configStoreClient } = relayerClients;

    const relayer = new Relayer(await baseSigner.getAddress(), logger, relayerClients, config);

    logger.debug({ at: "Relayer#index", message: "Relayer components initialized. Starting execution loop" });

    for (;;) {
      await updateRelayerClients(relayerClients, config);

      if (!config.skipRelays) {
        // @note: For fills with a different repaymentChainId, refunds are requested on the _subsequent_ relayer run.
        // Refunds requests are enqueued before new fills, so fillRelay simulation occurs closest to txn submission.
        const version = configStoreClient.getConfigStoreVersionForTimestamp();
        if (sdkUtils.isUBA(version) && version <= configStoreClient.configStoreVersion) {
          await relayer.requestRefunds(config.sendingSlowRelaysEnabled);
        }

        await relayer.checkForUnfilledDepositsAndFill(config.sendingSlowRelaysEnabled);

        await relayerClients.multiCallerClient.executeTransactionQueue(!config.sendingRelaysEnabled);
      }

      // Unwrap WETH after filling deposits so we don't mess up slow fill logic, but before rebalancing
      // any tokens so rebalancing can take into account unwrapped WETH balances.
      await relayerClients.inventoryClient.unwrapWeth();

      if (!config.skipRebalancing) {
        await relayerClients.inventoryClient.rebalanceInventoryIfNeeded();
      }

      // Clear state from profit and token clients. These are updated on every iteration and should start fresh.
      relayerClients.profitClient.clearUnprofitableFills();
      relayerClients.tokenClient.clearTokenShortfall();

      if (await processEndPollingLoop(logger, "Relayer", config.pollingDelay)) {
        break;
      }
    }
  } finally {
    await disconnectRedisClients(logger);
  }
}
