import { winston, config, startupLogLevel, Signer, disconnectRedisClients, getDispatcherKeys } from "../utils";
import { DepositAddressHandler } from "./DepositAddressHandler";
import { DepositAddressHandlerConfig } from "./DepositAddressHandlerConfig";

config();
let logger: winston.Logger;

export async function runDepositAddressHandler(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new DepositAddressHandlerConfig(process.env);
  const dispatcherKeys = await getDispatcherKeys();
  const relayer = new DepositAddressHandler(logger, config, baseSigner, dispatcherKeys);
  await relayer.initialize();

  try {
    logger[startupLogLevel(config)]({
      at: "DepositAddressHandler#index",
      message: "Deposit address handler started",
      config,
    });
    const start = Date.now();

    // Start the API polling.
    relayer.pollAndExecute();

    // Wait for the handover to complete.
    await relayer.waitForDisconnect();

    logger.debug({ at: "DepositAddressHandler#index", message: `Time to run: ${(Date.now() - start) / 1000}s` });
  } finally {
    // Let work that is already in flight finish recording its outcome *before* closing the clients
    // it needs. A confirmed execute whose Redis write lands on a disconnected client is lost, and a
    // lifecycle event published through a closed client is dropped without a trace.
    await relayer.drain();
    await relayer.disconnect();
    await disconnectRedisClients(logger);
  }
}
