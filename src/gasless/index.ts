import { winston, config, startupLogLevel, Signer, disconnectRedisClients, getDispatcherKeys } from "../utils";
import { GaslessRelayer } from "./GaslessRelayer";
import { GaslessRelayerConfig } from "./GaslessRelayerConfig";

config();
let logger: winston.Logger;

export async function runGaslessRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new GaslessRelayerConfig(process.env);
  const dispatcherKeys = await getDispatcherKeys();
  const relayer = new GaslessRelayer(logger, config, baseSigner, dispatcherKeys);
  await relayer.initialize();

  try {
    logger[startupLogLevel(config)]({
      at: "GaslessRelayer#index",
      message: "Gasless relayer started",
      config,
    });
    const start = Date.now();

    // Start the API polling.
    relayer.pollAndExecute();

    // Wait for the handover to complete.
    await relayer.waitForDisconnect();

    logger.debug({ at: "GaslessRelayer#index", message: `Time to run: ${(Date.now() - start) / 1000}s` });
  } finally {
    await disconnectRedisClients(logger);
  }
}
