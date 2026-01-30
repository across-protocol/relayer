import winston from "winston";
import { GaslessRelayerConfig } from "./GaslessRelayerConfig";
import { isDefined, getRedisCache, delay, Signer, scheduleTask, forEachAsync } from "../utils";
import { AcrossSwapApiClient } from "../clients";

const abortController = new AbortController();

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class GaslessRelayer {
  private initialized = false;
  private observedSignatures = new Set<string>();
  private api: AcrossSwapApiClient;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: GaslessRelayerConfig,
    readonly baseSigner: Signer
  ) {
    this.api = new AcrossSwapApiClient(this.logger);
  }

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
   * @notice Polls the Across gasless API and starts background deposit/fill tasks.
   */
  public pollAndExecute(): void {
    scheduleTask(() => this.evaluateApiSignatures(), this.config.apiPollingInterval, abortController.signal);
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

  private async evaluateApiSignatures(): Promise<void> {
    const apiSignatures = await this.api.get<string[]>(this.config.apiEndpoint, {}); // Query the API.
    await forEachAsync(
      apiSignatures.filter((signature) => !this.observedSignatures.has(signature)),
      async (signature) => {
        // Mark the signature as observed.
        this.observedSignatures.add(signature);

        // Initiate the deposit.

        // Take the logs from the transaction receipt.

        // Fill the deposit.
      }
    );
  }
}
