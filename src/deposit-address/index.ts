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
    const start = Date.now();

    // initialize() cedes without loading state when a shutdown or a newer instance is observed
    // while it waits for the predecessor drain; a stale instance must not start polling. It still
    // falls through to waitForDisconnect below so its drained signal reaches any successor.
    if (relayer.aborted) {
      logger.debug({
        at: "DepositAddressHandler#index",
        message: "Handler ceded during initialization; exiting without polling.",
      });
    } else {
      logger[startupLogLevel(config)]({
        at: "DepositAddressHandler#index",
        message: "Deposit address handler started",
        config,
      });

      // Start the API polling.
      relayer.pollAndExecute();
    }

    // Wait for the handover to complete.
    await relayer.waitForDisconnect();

    logger.debug({ at: "DepositAddressHandler#index", message: `Time to run: ${(Date.now() - start) / 1000}s` });
  } finally {
    await relayer.disconnect();
    await disconnectRedisClients(logger);
  }
}
