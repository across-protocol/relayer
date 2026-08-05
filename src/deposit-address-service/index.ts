import { Server } from "http";
import { config, Logger, waitForLogger } from "../utils";
import { stringifyThrownValue } from "../utils/LogUtils";
import { createApp } from "./app";
import { DepositAddressServiceConfig } from "./config";
import { RequestLifecycle } from "./lifecycle";

config();

const AT = "DepositAddressService#bootstrap";

/**
 * Run directly, not through the repo's `index.ts` bot dispatcher — `scripts/runCommand.sh` executes
 * `$COMMAND`, so no Dockerfile change is needed:
 *
 *   COMMAND="node ./dist/src/deposit-address-service/index.js"
 *
 * Uses the shared `Logger`, not a local winston instance, so `notificationPath` routing works and
 * `botIdentifier` / `runIdentifier` are injected.
 */
function main(): void {
  const logger = Logger;
  const serviceConfig = new DepositAddressServiceConfig(process.env);
  const lifecycle = new RequestLifecycle();
  const app = createApp({ logger, config: serviceConfig, lifecycle });

  const server = app.listen(serviceConfig.port, "0.0.0.0", () => {
    logger.debug({
      at: AT,
      message: "Deposit-address service listening",
      port: serviceConfig.port,
    });
  });

  installFatalHandlers(logger);
  installShutdownHandlers(logger, server, lifecycle, serviceConfig);
}

function installFatalHandlers(logger: typeof Logger): void {
  // The only lines here above `debug`, at `error` so they page: the process is exiting, so whatever was
  // in flight is abandoned. Stringified because `error` is a reserved key the logger rewrites.
  process.on("uncaughtException", (error) => {
    logger.error({ at: AT, message: "Uncaught exception", err: stringifyThrownValue(error) });
    void exitAfterFlush(logger, 1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ at: AT, message: "Unhandled rejection", err: stringifyThrownValue(reason) });
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

main();
