import winston from "winston";
import { GaslessRelayerConfig } from "./GaslessRelayerConfig";
import { isDefined, getRedisCache, delay, Signer } from "../utils";

const abortController = new AbortController();
// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class GaslessRelayer {
  private initialized = false;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: GaslessRelayerConfig,
    readonly baseSigner: Signer
  ) {}

  /*
   * @notice Initializes a GaslessRelayer instance.
   */
  public async initialize(): Promise<void> {
    process.on("SIGHUP", () => {
      this.logger.debug({
        at: "GaslessRelayer#initialize",
        message: "Received SIGHUP on gasless relayer. stopping...",
      });
      abortController.abort();
    });

    process.on("disconnect", () => {
      this.logger.debug({
        at: "GaslessRelayer#initialize",
        message: "Gasless relayer disconnected, stopping...",
      });
      abortController.abort();
    });
    this.initialized = true;
  }

  /*
   * @notice Utility function which tells the relayer when a handoff has occurred.
   * Calls the abort controller and settles this function's promise once a handoff is observed.
   */
  public async waitForDisconnect(): Promise<void> {
    const {
      RUN_IDENTIFIER: runIdentifier,
      BOT_IDENTIFIER: botIdentifier,
      MAX_CYCLES: _maxCycles = 120,
      DISCONNECT_POLLING_DELAY: _pollingDelay = 3,
    } = process.env;
    const maxCycles = Number(_maxCycles);
    const pollingDelay = Number(_pollingDelay);
    const redis = await getRedisCache(this.logger);
    // Set the active instance immediately on arrival here. This function will poll until it reaches the max amount of
    // runs or it is interrupted by another process.
    if (isDefined(runIdentifier) && isDefined(botIdentifier)) {
      await redis.set(botIdentifier, runIdentifier, maxCycles * pollingDelay);
      for (let run = 0; run < maxCycles; run++) {
        const currentBot = await redis.get(botIdentifier);
        if (currentBot !== runIdentifier) {
          this.logger.debug({
            at: "GaslessRelayer#waitForDisconnect",
            message: `Handing over ${runIdentifier} instance to ${currentBot} for ${botIdentifier}`,
            run,
          });
          abortController.abort();
          return;
        }
        await delay(pollingDelay);
      }
      // If we finish looping without receiving a handover signal, still exit so that we won't await the other promise forever.
      abortController.abort();
    }
  }
}
