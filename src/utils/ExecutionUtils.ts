import { delay, winston } from "./";

export function exit(code: number): void {
  // eslint-disable-next-line no-process-exit
  process.exit(code);
}

export async function processEndPollingLoop(
  logger: winston.Logger,
  fileName: string,
  pollingDelay: number
): Promise<boolean> {
  if (pollingDelay === 0) {
    logger.debug({ at: `${fileName}#index`, message: "End of serverless execution loop - terminating process" });
    return true;
  }

  logger.debug({ at: `${fileName}#index`, message: `End of execution loop - waiting polling delay ${pollingDelay}s` });
  await delay(pollingDelay);
  return false;
}

export function startupLogLevel(config: { pollingDelay: number }): "info" | "debug" {
  return config.pollingDelay > 0 ? "info" : "debug";
}

/**
 * @description Compute how long to wait before the next retry attempt.
 * @param attempt 0-indexed number of attempts that have already failed.
 * @param base Exponential base. Defaults to 2, producing waits of ~1s, ~2s, ~4s, ...
 * @returns Seconds to sleep, including up to 1s of jitter so that bots sharing an upstream API don't
 * retry in lockstep. Mirrors the backoff used by the SDK's retry() helper.
 */
export function retryBackoffS(attempt: number, base = 2): number {
  return base ** attempt + Math.random();
}

export function rejectAfterDelay(seconds: number, message = ""): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(reject, seconds * 1000, {
      status: "timeout",
      message: `Execution took longer than ${seconds}s. ${message}`,
    });
  });
}
