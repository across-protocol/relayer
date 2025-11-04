import { winston, config, startupLogLevel, Signer, disconnectRedisClients } from "../utils";
import { HyperliquidExecutor } from "./HyperliquidExecutor";
import { HyperliquidFinalizer } from "./HyperliquidFinalizer";
import {
  constructHyperliquidFinalizerClients,
  constructHyperliquidExecutorClients,
} from "./HyperliquidBotClientHelper";
import { HyperliquidBotConfig } from "./HyperliquidBotConfig";
config();
let logger: winston.Logger;

export async function runHyperliquidExecutor(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new HyperliquidBotConfig(process.env);
  const clients = await constructHyperliquidExecutorClients(config, logger, baseSigner);
  const executor = new HyperliquidExecutor(logger, config, clients);
  await executor.initialize();

  try {
    logger[startupLogLevel(config)]({
      at: "HyperliquidExecutor#index",
      message: "HyperliquidExecutor started",
      config,
    });
    const start = Date.now();
    await executor.shuffleOrders();

    await clients.multiCallerClient.executeTxnQueues();

    logger.debug({ at: "HyperliquidExecutor#index", message: `Time to run: ${(Date.now() - start) / 1000}s` });
  } finally {
    await disconnectRedisClients(logger);
  }
}

export async function runHyperliquidFinalizer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new HyperliquidBotConfig(process.env);
  const clients = await constructHyperliquidFinalizerClients(config, logger, baseSigner);
  const finalizer = new HyperliquidFinalizer(logger, config, clients);
  await finalizer.initialize();

  try {
    logger[startupLogLevel(config)]({
      at: "HyperliquidFinalizer#index",
      message: "HyperliquidFinalizer started",
      config,
    });
    const start = Date.now();
    await clients.multiCallerClient.executeTxnQueues();

    logger.debug({ at: "HyperliquidFinalizer#index", message: `Time to run: ${(Date.now() - start) / 1000}s` });
  } finally {
    await disconnectRedisClients(logger);
  }
}
