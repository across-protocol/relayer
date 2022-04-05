import { delay, winston } from "./";

export async function processEndPollingLoop(logger: winston.Logger, fileName: String, pollingDelay: number) {
  if (pollingDelay === 0) {
    logger.debug({ at: `${fileName}#index`, message: "End of serverless execution loop - terminating process" });
    return true;
  }

  logger.debug({ at: `${fileName}#index`, message: `End of execution loop - waiting polling delay ${pollingDelay}s` });
  await delay(pollingDelay);
  return false;
}
