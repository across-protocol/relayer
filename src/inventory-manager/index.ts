import assert from "assert";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { InventoryClientState } from "../clients";
import { config, disconnectRedisClients, getRedisCache, isDefined, Signer, winston } from "../utils";
import { InventoryManagerConfig } from "./InventoryManagerConfig";
import { constructInventoryManagerClients } from "./InvenotryClientHelper";
import { updateSpokePoolClients } from "../common";
config();
let logger: winston.Logger;

const { INVENTORY_TOPIC = "across-relayer-inventory" } = process.env;
type RedisCache = Awaited<ReturnType<typeof getRedisCache>>;

export async function runInventoryManager(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const personality = "InventoryManager";
  const at = `${personality}::run`;
  const config = new InventoryManagerConfig(process.env);
  logger = _logger;

  try {
    const redis = await getRedisCache(logger);

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

    const inventory = inventoryClient.export();
    await setInventoryState(redis, INVENTORY_TOPIC, inventory);
  } finally {
    await disconnectRedisClients(logger);
    logger.debug({ at, message: `${personality} instance completed.` });
  }
}

async function setInventoryState(redis: RedisCache, topic: string, state: InventoryClientState): Promise<void> {
  const value = JSON.stringify(state, sdkUtils.jsonReplacerWithBigNumbers);
  await redis.set(topic, value);
}

async function getInventoryState(redis: RedisCache, topic: string): Promise<InventoryClientState | undefined> {
  const state = await redis.get<string>(topic);
  if (!isDefined(state)) {
    return undefined;
  }

  const processedState = JSON.parse(state, sdkUtils.jsonReviverWithBigNumbers);
  return processedState;
}
