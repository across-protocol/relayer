import winston from "winston";
import { DepositAddressHandlerConfig } from "./DepositAddressHandlerConfig";
import {
  getRedisCache,
  isDefined,
  Signer,
  scheduleTask,
  Provider,
  EvmAddress,
  InstanceCoordinator,
  forEachAsync,
  getProvider,
  Contract,
  sendAndConfirmTransaction,
  getCounterfactualDepositFactory,
  buildDeployTx,
  getDepositKey,
  TransactionReceipt,
} from "../utils";
import { DepositAddressMessage } from "../interfaces";
import { AcrossSwapApiClient, TransactionClient } from "../clients";
import { AcrossIndexerApiClient } from "../clients/AcrossIndexerApiClient";

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class DepositAddressHandler {
  private abortController = new AbortController();
  private instanceCoordinator;
  private initialized = false;

  private providersByChain: { [chainId: number]: Provider } = {};

  private counterfactualDepositFactories: { [chainId: number]: Contract } = {};

  /** Per chainId: set of deposit keys already executed (like gasless depositNonces). */
  private observedExecutedDeposits: { [chainId: number]: Set<string> } = {};

  private api: AcrossSwapApiClient;
  private indexerApi: AcrossIndexerApiClient;
  private signerAddress: EvmAddress;

  private transactionClient;
  private redisCache;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: DepositAddressHandlerConfig,
    readonly baseSigner: Signer,
    readonly depositAddressSigners: Signer[]
  ) {
    this.api = new AcrossSwapApiClient(this.logger, this.config.apiTimeoutOverride);
    this.indexerApi = new AcrossIndexerApiClient(this.logger, this.config.apiTimeoutOverride);
    this.transactionClient = new TransactionClient(this.logger, depositAddressSigners);
  }

  /*
   * @notice Initializes a DepositAddressHandler instance.
   */
  public async initialize(): Promise<void> {
    this.logger.debug({
      at: "DepositAddressHandler#initialize",
      message: "Initializing DepositAddressHandler",
    });

    const { RUN_IDENTIFIER: runIdentifier, BOT_IDENTIFIER: botIdentifier } = process.env;

    // Set the signer address.
    this.signerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.redisCache = await getRedisCache(this.logger);

    // Exit if OS instructs us to do so.
    process.on("SIGHUP", () => {
      this.logger.debug({
        at: "DepositAddressHandler#initialize",
        message: "Received SIGHUP on deposit address handler. stopping...",
      });
      this.abortController.abort();
    });

    process.on("disconnect", () => {
      this.logger.debug({
        at: "DepositAddressHandler#initialize",
        message: "Deposit address handler disconnected, stopping...",
      });
      this.abortController.abort();
    });

    await forEachAsync(this.config.relayerOriginChains, async (chainId) => {
      const provider = await getProvider(chainId);
      this.providersByChain[chainId] = provider;
      this.counterfactualDepositFactories[chainId] = getCounterfactualDepositFactory(chainId).connect(provider);
      this.observedExecutedDeposits[chainId] = new Set<string>();
    });

    // Establish a new bot instance.
    this.instanceCoordinator = new InstanceCoordinator(
      this.logger,
      this.redisCache,
      botIdentifier,
      runIdentifier,
      this.abortController
    );
    await this.instanceCoordinator.initiateHandover();

    this.initialized = true;
  }

  /*
   * @notice Polls the Across indexer API and starts background tasks.
   */
  public pollAndExecute(): void {
    scheduleTask(
      () => this.evaluateDepositAddresses(),
      this.config.indexerPollingInterval,
      this.abortController.signal
    );
  }

  /*
   * @notice Utility function which tells the relayer when a handoff has occurred.
   * Calls the abort controller and settles this function's promise once a handoff is observed.
   */
  public async waitForDisconnect(): Promise<void> {
    await this.instanceCoordinator.subscribe();
    this.abortController.abort();
  }

  private async evaluateDepositAddresses(): Promise<void> {
    // @TODO: This is just initial implementation. We will need to add more logic to it when Indexer and Swap API Endpoints are implemented.
    const depositMessages = await this._queryIndexerApi();
    await forEachAsync(depositMessages, async (depositMessage) => {
      await this.initiateDeposit(depositMessage);
    });
  }

  private async initiateDeposit(depositMessage: DepositAddressMessage): Promise<void> {
    const originChainId = Number(depositMessage.routeParams.originChainId);
    const depositKey = getDepositKey(depositMessage);
    if (this.observedExecutedDeposits[originChainId]?.has(depositKey)) {
      return;
    }

    let factoryContract = this.counterfactualDepositFactories[originChainId];
    if (!factoryContract) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateDeposit",
        message: "No counterfactual deposit factory for chain; skipping",
        originChainId,
      });
      return;
    }

    // Transaction input (calldata) directly from Swap API.
    const executeTxInput = await this._getSwapApiQuote(depositMessage);
    // This is here because of the lint error.
    void executeTxInput;

    const useDispatcher = this.depositAddressSigners.length > 0;
    if (!useDispatcher) {
      factoryContract = factoryContract.connect(this.baseSigner.connect(this.providersByChain[originChainId]));
    }

    if (depositMessage.salt) {
      const deployTx = buildDeployTx(
        factoryContract,
        originChainId,
        depositMessage.depositAddress,
        depositMessage.routeParams,
        depositMessage.salt
      );
      let deployReceipt: TransactionReceipt | undefined = undefined;
      try {
        deployReceipt = await sendAndConfirmTransaction(deployTx, this.transactionClient, useDispatcher);
      } catch (err) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateDeposit",
          message: "Failed to submit deploy tx",
          depositKey,
        });
        return;
      }

      if (!deployReceipt) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateDeposit",
          message: "Failed to submit deploy tx",
          depositKey,
        });
        return;
      }
    }

    // @TODO: Implement sending the execute tx from the calldata we got from the Swap API.
    // const receipt = await submitAndWaitForReceipt(
    //   executeTx,
    //   this.transactionClient,
    //   this.logger,
    //   "DepositAddressHandler#initiateDeposit",
    //   useDispatcher
    // );

    // This is here because of the lint error.
    let receipt;
    if (receipt) {
      this.observedExecutedDeposits[originChainId].add(depositKey);
      this.logger.info({
        at: "DepositAddressHandler#initiateDeposit",
        message: "Submitted deploy + execute tx",
        hash: receipt.transactionHash,
        depositAddress: depositMessage.depositAddress,
      });
    }
  }

  /*
   * @notice Queries the Indexer API for all pending deposit addresses transactions. By default, do not retry since this endpoing is being polled.
   */
  private async _queryIndexerApi(retriesRemaining = 0): Promise<DepositAddressMessage[]> {
    let apiResponseData: { depositAddresses: DepositAddressMessage[] } | undefined = undefined;
    try {
      apiResponseData = await this.indexerApi.get<{ depositAddresses: DepositAddressMessage[] }>(
        this.config.indexerApiEndpoint,
        {}
      );
    } catch {
      // Error log should have been emitted in IndexerApiClient.
    }
    if (!isDefined(apiResponseData)) {
      return retriesRemaining > 0 ? this._queryIndexerApi(--retriesRemaining) : [];
    }
    return apiResponseData.depositAddresses;
  }

  private async _getSwapApiQuote(depositMessage: DepositAddressMessage): Promise<string> {
    // TODO: Implement this.
    void depositMessage;
    return "";
  }
}
