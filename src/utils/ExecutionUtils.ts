import { AnyObject, delay, winston } from "./";

export async function processEndPollingLoop(
  logger: winston.Logger,
  fileName: string,
  pollingDelay: number
): Promise<boolean> {
  if (pollingDelay === 0) {
    logger.debug({ at: `${fileName}#index`, message: "End of serverless execution loop - terminating process" });
    await delay(5); // Add a small delay to ensure the transports have fully flushed upstream.
    return true;
  }

  logger.debug({ at: `${fileName}#index`, message: `End of execution loop - waiting polling delay ${pollingDelay}s` });
  await delay(pollingDelay);
  return false;
}

export async function processCrash(
  logger: winston.Logger,
  fileName: string,
  pollingDelay: number,
  error: AnyObject
): Promise<boolean> {
  logger.error({
    at: `${fileName}#index`,
    message: `There was an execution error! ${pollingDelay != 0 ? "Re-running loop" : ""}`,
    error,
    notificationPath: "across-error",
  });
  await delay(5);
  if (pollingDelay === 0) {
    return true;
  }

  return false;
}

export function startupLogLevel(config: { pollingDelay: number }): string {
  return config.pollingDelay > 0 ? "info" : "debug";
}

export function rejectAfterDelay(seconds: number, message = ""): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(reject, seconds * 1000, {
      status: "timeout",
      message: `Execution took longer than ${seconds}s. ${message}`,
    });
  });
}

/**
 * Run a batch of async functions in parallel or sequentially.
 * @param asyncFunctions The async functions to run.
 * @param sequential Whether to run the functions sequentially or in parallel.
 */
export async function runBatchAsyncFunctions(
  asyncFunctions: Array<() => Promise<unknown>>,
  sequential = false
): Promise<void> {
  if (sequential) {
    for (const fn of asyncFunctions) {
      await fn();
    }
  } else {
    await Promise.all(asyncFunctions.map((fn) => fn()));
  }
}
