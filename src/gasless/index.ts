import { winston, config, startupLogLevel, Signer, disconnectRedisClients } from "../utils";
import { GaslessRelayer } from "./GaslessRelayer";
import { GaslessRelayerConfig } from "./GaslessRelayerConfig";

config();
let logger: winston.Logger;

export async function runGaslessRelayer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new GaslessRelayerConfig(process.env);
  const relayer = new GaslessRelayer(logger, config, baseSigner);
  await relayer.initialize();

  try {
    logger[startupLogLevel(config)]({
      at: "GaslessRelayer#index",
      message: "Gasless relayer started",
      config,
    });
    const start = Date.now();

    const waitForHandover = relayer.waitForDisconnect();
    await Promise.allSettled([waitForHandover]);

    logger.debug({ at: "GaslessRelayer#index", message: `Time to run: ${(Date.now() - start) / 1000}s` });
  } finally {
    await disconnectRedisClients(logger);
  }
}
