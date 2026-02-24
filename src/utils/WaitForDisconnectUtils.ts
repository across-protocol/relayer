import { isDefined } from "./TypeGuards";
import { delay } from "./SDKUtils";
import winston from "winston";

export interface WaitForDisconnectParams {
  /** Current run instance id (e.g. from RUN_IDENTIFIER). */
  runIdentifier: string | undefined;
  /** Bot identifier key in Redis (e.g. from BOT_IDENTIFIER). */
  botIdentifier: string | undefined;
  /** Max number of polling cycles before forcing abort. */
  maxCycles: number;
  /** Delay in seconds between each poll. */
  pollingDelay: number;
  /** Redis-like client: set(key, value, expirySeconds), get(key). */
  redis: {
    set(key: string, value: string, expirySeconds: number): Promise<string | undefined>;
    get(key: string): Promise<string | undefined>;
  };
  /** Called when handover is detected or max cycles reached. */
  onAbort: () => void;
  /** Logger for handover message. */
  logger: winston.Logger;
  /** Value for the `at` field in log (e.g. "GaslessRelayer#waitForDisconnect"). */
  logAt: string;
}

/**
 * Polls Redis until another process overwrites the active instance (handover) or max cycles is reached.
 * Sets the current run as active, then polls; when a different instance is seen or cycles exhaust, calls onAbort().
 */
export async function waitForDisconnect(params: WaitForDisconnectParams): Promise<void> {
  const { runIdentifier, botIdentifier, maxCycles, pollingDelay, redis, onAbort, logger, logAt } = params;

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
      onAbort();
      return;
    }
    await delay(pollingDelay);
  }

  onAbort();
}
