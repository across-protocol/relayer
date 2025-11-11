import {
  config,
  getRedisCache,
  Profiler,
  Signer,
  winston,
} from "../utils";
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

  logger = _logger;
  const config = new InventoryManagerConfig(process.env);

  const redis = await getRedisCache(logger);

  const clients = await constructInventoryManagerClients(logger, config, baseSigner);

  const { spokePoolClients, inventoryClient } = clients;

  await updateSpokePoolClients(spokePoolClients, [
    "FundsDeposited",
    "RequestedSpeedUpDeposit",
    "FilledRelay",
    "RelayedRootBundle",
    "ExecutedRelayerRefundRoot",
  ]);

  await inventoryClient.update(config.spokePoolChainsOverride);

  await inventoryClient.export(redis)
}

