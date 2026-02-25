import { EventListener } from "../clients";
import { CHAIN_IDs, winston, config, startupLogLevel, Signer, disconnectRedisClients } from "../utils";
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
      message: "HyperliquidExecutor started",
      config,
    });
    const start = Date.now();

    executor.startListeners();
    const processTasks = executor.processTasks();
    const waitForHandover = executor.waitForDisconnect();
    await Promise.allSettled([processTasks, waitForHandover]);

    logger.debug({ at: "HyperliquidExecutor#index", message: `Time to run: ${(Date.now() - start) / 1000}s` });
  } finally {
    await disconnectRedisClients(logger);
  }
}

export async function runHyperliquidFinalizer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;

  const config = new HyperliquidExecutorConfig(process.env);
  const clients = await constructHyperliquidExecutorClients(config, logger, baseSigner);
  const finalizer = new HyperliquidExecutor(logger, config, clients);
  await finalizer.initialize();

  const listener = new EventListener(CHAIN_IDs.HYPEREVM, logger, 1);
  const onBlock = (blockNumber: number) => {
    if (blockNumber % config.settlementInterval === 0) {
      setTimeout(() => finalizer.finalizeSwapFlows(blockNumber));
    }
  };
  listener.onBlock(onBlock);

  const start = performance.now();
  try {
    logger[startupLogLevel(config)]({
      at: "HyperliquidFinalizer#index",
      message: "HyperliquidFinalizer started",
      config,
    });

    await finalizer.waitForDisconnect();
  } finally {
    await disconnectRedisClients(logger);
    const runtime = Math.round((performance.now() - start) / 1000);
    logger.debug({ at: "HyperliquidFinalizer#index", message: `Time to run: ${runtime} s` });
  }
}
