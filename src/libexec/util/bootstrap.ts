import { disconnectRedisClients, exit, Logger, winston } from "../../utils";
import * as utils from "../../../scripts/utils";

const { NODE_SUCCESS, NODE_APP_ERR } = utils;

type Run = (argv: string[]) => Promise<void>;

/**
 * Returns a Promise that resolves when `signal` fires, or immediately if the
 * signal is already aborted. Avoids the `addEventListener('abort', …)`-after-abort
 * race where a listener attached to an already-aborted signal never fires.
 */
export function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
}

/**
 * Standard bootstrap for libexec listener child processes:
 *  - install SIGHUP/disconnect handlers that abort the controller before run() starts
 *  - invoke run() and translate its outcome to a process exit code
 *  - disconnect redis and exit cleanly
 *
 * `chainName` is read lazily because callers populate their module-level chain
 * binding inside run() once the chainId is known.
 */
export function bootstrap(args: {
  program: string;
  abortController: AbortController;
  chainName: () => string | undefined;
  run: Run;
}): void {
  const { program, abortController, chainName, run } = args;
  const logger: winston.Logger = Logger;
  const at = program;
  const describe = () => chainName() ?? program;

  process.on("SIGHUP", () => {
    logger.debug({ at, message: `Received SIGHUP in ${describe()} listener, stopping...` });
    abortController.abort();
  });

  process.on("disconnect", () => {
    logger.debug({ at, message: `${describe()} parent disconnected, stopping...` });
    abortController.abort();
  });

  run(process.argv.slice(2))
    .then(() => {
      process.exitCode = NODE_SUCCESS;
    })
    .catch((error) => {
      logger.error({ at, message: `${describe()} listener exited with error.`, error });
      process.exitCode = NODE_APP_ERR;
    })
    .finally(async () => {
      await disconnectRedisClients();
      logger.debug({ at, message: `Exiting ${describe()} listener.` });
      exit(Number(process.exitCode));
    });
}
