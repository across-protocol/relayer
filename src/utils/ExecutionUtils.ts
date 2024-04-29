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
    await delay(5); // Add a small delay to ensure the transports have fully flushed upstream.
    return true;
  }

  logger.debug({ at: `${fileName}#index`, message: `End of execution loop - waiting polling delay ${pollingDelay}s` });
  await delay(pollingDelay);
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
