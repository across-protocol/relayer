import { winston, config, startupLogLevel, Signer, disconnectRedisClients } from "../utils";
import { HyperliquidExecutor } from "./HyperliquidExecutor";
import { constructHyperliquidExecutorClients } from "./HyperliquidExecutorClientHelper";
import { HyperliquidExecutorConfig } from "./HyperliquidExecutorConfig";
config();
let logger: winston.Logger;

export async function runHyperliquidExecutor(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new HyperliquidExecutorConfig(process.env);
  const clients = await constructHyperliquidExecutorClients(config, logger, baseSigner);
  const executor = new HyperliquidExecutor(logger, config, clients);
  await executor.initialize();

  try {
    logger[startupLogLevel(config)]({
      at: "HyperliquidExecutor#index",
      message: "HyperliquidExecutor started ⛽️",
      config,
    });
    const start = Date.now();

    await clients.multiCallerClient.executeTxnQueues();

    logger.debug({ at: "HyperliquidExecutor#index", message: `Time to run: ${(Date.now() - start) / 1000}s` });
  } finally {
    await disconnectRedisClients(logger);
  }
}
