import winston from "winston";
import { PersistentAddressesConfig } from "./PersistentAddressesConfig";
import {
  getRedisCache,
  isDefined,
  Signer,
  scheduleTask,
  Provider,
  EvmAddress,
  waitForDisconnect as waitForDisconnectUtil,
} from "../utils";
import { PersistentAddressesMessage } from "../interfaces";
import { AcrossSwapApiClient, TransactionClient } from "../clients";
import { AcrossIndexerApiClient } from "../clients/AcrossIndexerApiClient";

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class PersistentAddressesRelayer {
  private abortController = new AbortController();
  private initialized = false;

  private providersByChain: { [chainId: number]: Provider } = {};

  private api: AcrossSwapApiClient;
  private indexerApi: AcrossIndexerApiClient;
  private signerAddress: EvmAddress;

  private transactionClient;
  private redisCache;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: PersistentAddressesConfig,
    readonly baseSigner: Signer,
    readonly persistentAddressesSigners: Signer[]
  ) {
    this.api = new AcrossSwapApiClient(this.logger, this.config.apiTimeoutOverride);
    this.indexerApi = new AcrossIndexerApiClient(this.logger, this.config.apiTimeoutOverride);
    this.transactionClient = new TransactionClient(this.logger, persistentAddressesSigners);
  }

  /*
   * @notice Initializes a PersistentAddressesRelayer instance.
   */
  public async initialize(): Promise<void> {
    this.logger.debug({
      at: "PersistentAddressesRelayer#initialize",
      message: "Initializing PersistentAddressesRelayer",
    });

    // Set the signer address.
    this.signerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.redisCache = await getRedisCache(this.logger);

    // Exit if OS instructs us to do so.
    process.on("SIGHUP", () => {
      this.logger.debug({
        at: "PersistentAddressesRelayer#initialize",
        message: "Received SIGHUP on persistent addresses relayer. stopping...",
      });
      this.abortController.abort();
    });

    process.on("disconnect", () => {
      this.logger.debug({
        at: "PersistentAddressesRelayer#initialize",
        message: "Persistent addresses relayer disconnected, stopping...",
      });
      this.abortController.abort();
    });

    this.initialized = true;
  }

  /*
   * @notice Polls the Across indexer API and starts background tasks.
   */
  public pollAndExecute(): void {
    scheduleTask(
      () => this.evaluatePersistentAddresses(),
      this.config.indexerPoolingInterval,
      this.abortController.signal
    );
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
    await waitForDisconnectUtil({
      runIdentifier,
      botIdentifier,
      maxCycles: Number(_maxCycles),
      pollingDelay: Number(_pollingDelay),
      redis: this.redisCache,
      onAbort: () => this.abortController.abort(),
      logger: this.logger,
      logAt: "PersistentAddressesRelayer#waitForDisconnect",
    });
  }

  private async evaluatePersistentAddresses(): Promise<void> {
    // @TODO: Implement persistent addresses evaluation logic.
    // const persistentAddresses = await this._queryIndexerApi();
    this.logger.info({
      at: "PersistentAddressesRelayer#evaluatePersistentAddresses",
      message: "Evaluating persistent addresses",
    });
  }

  /*
   * @notice Queries the Indexer API for all pending persistent addresses transactions. By default, do not retry since this endpoing is being polled.
   */
  private async _queryIndexerApi(retriesRemaining = 0): Promise<PersistentAddressesMessage[]> {
    let apiResponseData: { persistentAddresses: PersistentAddressesMessage[] } | undefined = undefined;
    try {
      apiResponseData = await this.indexerApi.get<{ persistentAddresses: PersistentAddressesMessage[] }>(
        this.config.indexerApiEndpoint,
        {}
      );
    } catch {
      // Error log should have been emitted in AcrossSwapApiClient.
    }
    if (!isDefined(apiResponseData)) {
      return retriesRemaining > 0 ? this._queryIndexerApi(--retriesRemaining) : [];
    }
    return apiResponseData.persistentAddresses;
  }
}
