import { isDefined } from "./TypeGuards";
import { delay } from "./SDKUtils";
import winston from "winston";
import { RedisCacheInterface } from "../caching/RedisCache";

/**
 * Polls Redis until another process overwrites the active instance (handover) or max cycles is reached.
 * Sets the current run as active, then polls; when a different instance is seen or cycles exhaust, calls abortController.abort().
 */
export async function waitForDisconnect(
  runIdentifier: string | undefined,
  botIdentifier: string | undefined,
  maxCycles: number,
  pollingDelay: number,
  redis: RedisCacheInterface,
  abortController: AbortController,
  logger: winston.Logger,
  logAt: string
): Promise<void> {
  // Set the active instance immediately on arrival here. This function will poll until it reaches the max amount of
  // runs or it is interrupted by another process.
  if (!isDefined(runIdentifier) || !isDefined(botIdentifier)) {
    return;
  }

  await redis.set(botIdentifier, runIdentifier, maxCycles * pollingDelay);

  for (let run = 0; run < maxCycles; run++) {
    const currentBot = await redis.get(botIdentifier);
    if (currentBot !== runIdentifier) {
      logger.debug({
        at: logAt,
        message: `Handing over ${runIdentifier} instance to ${currentBot} for ${botIdentifier}`,
        run,
      });
      abortController.abort();
      return;
    }
    await delay(pollingDelay);
  }

  abortController.abort();
}
