import { config, getRedisCache, Profiler, Signer, winston } from "../utils";
import { InventoryManagerConfig } from "./InventoryManagerConfig";
import { constructInventoryManagerClients } from "./InvenotryClientHelper";
import { updateSpokePoolClients } from "../common";
config();
let logger: winston.Logger;

export async function runInventoryManager(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const profiler = new Profiler({
    at: "Relayer#run",
    logger: _logger,
  });

  void profiler;

  logger = _logger;
  const config = new InventoryManagerConfig(process.env);

  const redis = await getRedisCache(logger);
  void redis; // @TODO: lint fix, remove later

  const clients = await constructInventoryManagerClients(logger, config, baseSigner);

  const { spokePoolClients, inventoryClient } = clients;

  await updateSpokePoolClients(spokePoolClients, [
    "FundsDeposited",
    "FilledRelay",
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
  ]);

  inventoryClient.setBundleData();
  await inventoryClient.update(config.spokePoolChainsOverride);

  const exportedState = inventoryClient.export();
  // await redis.set("inventory_state", JSON.stringify(exportedState));
}
