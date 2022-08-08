import { delay, winston } from "./";

export async function processEndPollingLoop(logger: winston.Logger, fileName: string, pollingDelay: number) {
  if (pollingDelay === 0) {
    logger.debug({ at: `${fileName}#index`, message: "End of serverless execution loop - terminating process" });
    await delay(5); // Add a small delay to ensure the transports have fully flushed upstream.
    return true;
  }

  logger.debug({ at: `${fileName}#index`, message: `End of execution loop - waiting polling delay ${pollingDelay}s` });
  await delay(pollingDelay);
  return false;
}

export async function processCrash(logger: winston.Logger, fileName: string, pollingDelay: number, error: any) {
  logger.error({
    at: `${fileName}#index`,
    message: `There was an execution error! ${pollingDelay != 0 ? "Re-running loop" : ""}`,
    error: JSON.stringify(error),
    notificationPath: "across-error",
  });
  await delay(5);
  if (pollingDelay === 0) return true;

  return false;
}

export function startupLogLevel(config: { pollingDelay: number }) {
  return config.pollingDelay > 0 ? "info" : "debug";
}

export const rejectAfterDelay = (seconds: number, message = "") =>
  new Promise<never>((_, reject) => {
    setTimeout(reject, seconds * 1000, {
      status: "timeout",
      message: `Execution took longer than ${seconds}s. ${message}`,
    });
  });
