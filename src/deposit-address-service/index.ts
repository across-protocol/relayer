import { Server } from "http";
import minimist from "minimist";
import { getRedisCache } from "../cache/Redis";
import { AcrossSwapApiClient } from "../clients/AcrossSwapApiClient";
import { TransactionClient } from "../clients/TransactionClient";
import { getGcpPubSubPublisher } from "../messaging/gcp";
import { EvmAddress, assert, config, getDispatcherKeys, getSigner, isDefined, Logger, waitForLogger } from "../utils";
import { safeStringifyThrownValue } from "./errors";
import { createApp } from "./app";
import { DepositAddressServiceConfig } from "./config";
import { createDepositHandler } from "./depositHandler";
import { MessageHandler } from "./handler";
import { RequestLifecycle } from "./lifecycle";
import { TransferStore } from "./transferState";

config();

const AT = "DepositAddressService#bootstrap";

/**
 * Run directly, not through the repo's `index.ts` bot dispatcher — `scripts/runCommand.sh` executes
 * `$COMMAND`, so no Dockerfile change is needed:
 *
 *   COMMAND="exec node ./dist/src/deposit-address-service/index.js --wallet gckms --keys <key-name>"
 *
 * The `exec` is **required**. `runCommand.sh` runs `$COMMAND` without it, so the shell stays PID 1 and
 * Node is a child; Cloud Run signals PID 1 only, so the SIGTERM handler below would never fire and the
 * drain would silently not happen. `exec` replaces the shell with Node.
 *
 * Uses the shared `Logger`, not a local winston instance, so `notificationPath` routing works and
 * `botIdentifier` / `runIdentifier` are injected.
 */
async function main(): Promise<void> {
  const logger = Logger;
  const serviceConfig = new DepositAddressServiceConfig(process.env);
  const lifecycle = new RequestLifecycle();

  // Built before `listen()`, so a missing key or unreachable Redis fails startup rather than answering 500 to
  // every delivery. Constructed once and closed over by the handler: the nonce cache lives on
  // `TransactionClient`, so a per-request client would turn the accepted nonce race into a guaranteed one.
  const handler = await buildHandler(logger, serviceConfig);

  const app = createApp({ logger, config: serviceConfig, lifecycle, handler });

  const server = app.listen(serviceConfig.port, "0.0.0.0", () => {
    logger.debug({
      at: AT,
      message: "Deposit-address service listening",
      port: serviceConfig.port,
      originChains: serviceConfig.originChains,
      executionEnabled: serviceConfig.executionEnabled,
    });
  });

  installFatalHandlers(logger);
  installShutdownHandlers(logger, server, lifecycle, serviceConfig);
}

/**
 * Signer construction follows the repo's existing convention rather than inventing env vars for it: `--wallet`
 * and `--keys` through `minimist`, exactly as the bot dispatcher does, and `getDispatcherKeys()` which already
 * falls back to `DISPATCHER_KEYS` when no argument is passed.
 */
async function buildHandler(
  logger: typeof Logger,
  serviceConfig: DepositAddressServiceConfig
): Promise<MessageHandler> {
  const args = minimist(process.argv.slice(2), {
    string: ["wallet", "keys", "address"],
    default: { wallet: "secret" },
  });

  const baseSigner = await getSigner({ keyType: args.wallet, gckmsKeys: [args.keys], cleanEnv: true });
  const dispatcherSigners = await getDispatcherKeys();
  const signerAddress = EvmAddress.from(await baseSigner.getAddress());

  const redis = await getRedisCache(logger);
  assert(isDefined(redis), "DepositAddressService: a Redis cache is required for the lock and durable state");

  const { SWAP_API_KEY, API_TIMEOUT_OVERRIDE } = process.env;
  const swapApiKey = SWAP_API_KEY?.trim();
  assert(isDefined(swapApiKey) && swapApiKey.length > 0, "DepositAddressService: SWAP_API_KEY is required");

  // Asserted rather than degraded, like Redis above: a gate that is on with no publisher behind it announces
  // nothing, and that is invisible until a refund settles and the indexer is never told.
  const publisher = serviceConfig.withdrawPublisherEnabled
    ? getGcpPubSubPublisher(logger, serviceConfig.pubSubGcpProjectId)
    : undefined;
  assert(
    !serviceConfig.withdrawPublisherEnabled || isDefined(publisher),
    "DepositAddressService: the withdraw publisher is enabled but no Pub/Sub publisher could be built"
  );

  return createDepositHandler({
    logger,
    config: serviceConfig,
    store: new TransferStore(redis),
    api: new AcrossSwapApiClient(logger, Number(API_TIMEOUT_OVERRIDE ?? 3000), swapApiKey),
    transactionClient: new TransactionClient(logger, dispatcherSigners),
    baseSigner,
    signerAddress,
    dispatcherSigners,
    publisher,
  });
}

function installFatalHandlers(logger: typeof Logger): void {
  // The only lines here above `debug`, at `error` so they page: the process is exiting, so whatever was
  // in flight is abandoned. Serialization must not throw — an unguarded serializer would turn the page
  // into a report about itself and lose the real cause, and `exitAfterFlush` would never run.
  process.on("uncaughtException", (error) => {
    logger.error({ at: AT, message: "Uncaught exception", err: safeStringifyThrownValue(error) });
    void exitAfterFlush(logger, 1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ at: AT, message: "Unhandled rejection", err: safeStringifyThrownValue(reason) });
    void exitAfterFlush(logger, 1);
  });
}

/**
 * Drains in-flight requests before exiting. `SIGTERM` is what Cloud Run sends before terminating an
 * instance; the polling bot this replaces handles no equivalent, so eviction there kills in-flight
 * sweeps outright.
 */
function installShutdownHandlers(
  logger: typeof Logger,
  server: Server,
  lifecycle: RequestLifecycle,
  serviceConfig: DepositAddressServiceConfig
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.debug({
      at: AT,
      message: `Received ${signal}; draining in-flight requests before exit`,
      inFlight: lifecycle.inFlightCount,
      drainTimeoutMs: serviceConfig.shutdownDrainTimeoutMs,
    });

    const drained = await lifecycle.beginDraining(serviceConfig.shutdownDrainTimeoutMs);
    if (!drained) {
      logger.debug({
        at: AT,
        message: "Drain timed out with requests still in flight; abandoning them",
        inFlight: lifecycle.inFlightCount,
      });
    }

    await closeServer(logger, server);
    await exitAfterFlush(logger, drained ? 0 : 1);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
}

function closeServer(logger: typeof Logger, server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close((err) => {
      if (err) {
        logger.debug({ at: AT, message: "Error closing HTTP server", err: err.message });
      }
      resolve();
    });
    // Keep-alive sockets would otherwise hold `close()` open past the drain window.
    server.closeAllConnections?.();
  });
}

async function exitAfterFlush(logger: typeof Logger, exitCode: number): Promise<void> {
  await waitForLogger(logger);
  // eslint-disable-next-line no-process-exit -- the process is terminating; nothing left to unwind.
  process.exit(exitCode);
}

void main().catch((error) => {
  // Startup failed, so nothing is listening and there is nothing to drain. At `error` because a service that
  // cannot start is silent otherwise — Cloud Run would just report a failed revision.
  Logger.error({ at: AT, message: "Failed to start deposit-address service", err: safeStringifyThrownValue(error) });
  void exitAfterFlush(Logger, 1);
});
