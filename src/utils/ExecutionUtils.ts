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

/**
 * @description Run an async operation, backing off exponentially between retries.
 * @param fn Operation to run. Invoked once, then once more per retry.
 * @param nRetries Number of retries permitted after the initial attempt fails.
 * @param onError Optional callback, invoked with each failure before any backoff is applied.
 * @returns The result of the first successful attempt. Rethrows the last error once retries are exhausted.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  nRetries: number,
  onError?: (e: unknown, retriesRemaining: number) => void
): Promise<T> {
  for (let attempt = 0; ; ++attempt) {
    try {
      return await fn();
    } catch (e) {
      const retriesRemaining = nRetries - attempt;
      onError?.(e, retriesRemaining);
      if (retriesRemaining <= 0) {
        throw e;
      }
      await delay(retryBackoffS(attempt));
    }
  }
}

export function rejectAfterDelay(seconds: number, message = ""): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(reject, seconds * 1000, {
      status: "timeout",
      message: `Execution took longer than ${seconds}s. ${message}`,
    });
  });
}
