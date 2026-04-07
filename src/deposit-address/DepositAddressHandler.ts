import winston from "winston";
import { DepositAddressHandlerConfig } from "./DepositAddressHandlerConfig";
import {
  getRedisCache,
  isDefined,
  parseJson,
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
  toBN,
  getDepositKey,
  assert,
  getCounterfactualDepositImplementationAddress,
  getNetworkName,
  blockExplorerLink,
} from "../utils";
import { DepositAddressMessage } from "../interfaces";
import { AcrossSwapApiClient, TransactionClient, SwapApiResponse } from "../clients";
import { AcrossIndexerApiClient } from "../clients/AcrossIndexerApiClient";
import ERC20_ABI from "../common/abi/MinimalERC20.json";

// Teach BigInt how to be represented as JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  /** Set of erc20Transfer.transactionHash for deposits successfully executed (persisted in Redis for handover). */
  private executedDepositTxHashes: Set<string> = new Set();

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
    this.api = new AcrossSwapApiClient(this.logger, this.config.apiTimeoutOverride, this.config.swapApiKey);
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

    // Establish bot instance and take over. First thing after handover: load persisted executed deposits from Redis.
    this.instanceCoordinator = new InstanceCoordinator(
      this.logger,
      this.redisCache,
      botIdentifier,
      runIdentifier,
      this.abortController
    );
    await this.instanceCoordinator.initiateHandover();

    await this._loadExecutedDepositsFromRedis();

    this.initialized = true;
  }

  private getExecutedDepositsRedisKey(): string {
    const botId = process.env.BOT_IDENTIFIER ?? "deposit-address-handler";
    return `deposit-address:executed:${botId}`;
  }

  /** Loads executed deposit tx hashes from Redis (e.g. after handover). */
  private async _loadExecutedDepositsFromRedis(): Promise<void> {
    const redisKey = this.getExecutedDepositsRedisKey();
    const raw = (await this.redisCache.get(redisKey)) as string | undefined;
    let arr: string[] = [];
    try {
      if (raw) {
        arr = parseJson.stringArray(raw);
      }
    } catch (err) {
      this.logger.error({
        at: "DepositAddressHandler#_loadExecutedDepositsFromRedis",
        message: "Failed to parse executed deposits from Redis, using empty set",
        redisKey,
        err: err instanceof Error ? err.message : String(err),
      });

      throw err;
    }
    this.executedDepositTxHashes = new Set(arr);
    this.logger.debug({
      at: "DepositAddressHandler#_loadExecutedDepositsFromRedis",
      message: "Loaded executed deposit tx hashes from Redis",
      count: this.executedDepositTxHashes.size,
    });
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
    const depositMessages = await this._queryIndexerApi();
    const filtered = depositMessages.filter(
      (m) =>
        this.config.relayerOriginChains.includes(Number(m.routeParams.originChainId)) &&
        !this.executedDepositTxHashes.has(m.erc20Transfer.transactionHash)
    );

    // We want to remove all executed deposits from the in-memory set if they are not returned by the indexer.
    // This is because the indexer will stop sending the deposit once it has been "expired" (internal TTL).
    // So there is no point of keeping them in Redis after Indexer API stops returning them.
    const refTxHashesFromIndexer = new Set(depositMessages.map((m) => m.erc20Transfer.transactionHash));
    for (const tx of [...this.executedDepositTxHashes]) {
      if (!refTxHashesFromIndexer.has(tx)) {
        this.executedDepositTxHashes.delete(tx);
      }
    }

    await forEachAsync(filtered, async (depositMessage) => {
      await this.initiateDeposit(depositMessage);
    });
  }

  /**
   * Overwrites Redis key with the full executedDepositTxHashes set (single SET; value is JSON array).
   * Called at start of each poll (after filtering) and after each successful execute.
   */
  private async _persistExecutedDepositsRedis(): Promise<void> {
    const redisKey = this.getExecutedDepositsRedisKey();
    await this.redisCache.set(redisKey, JSON.stringify([...this.executedDepositTxHashes]));
  }

  private async initiateDeposit(depositMessage: DepositAddressMessage): Promise<void> {
    const {
      inputToken,
      originChainId: _originChainId,
      destinationChainId: _destinationChainId,
    } = depositMessage.routeParams;
    const { amount: _inputAmount, transactionHash: refTxHash } = depositMessage.erc20Transfer;
    const originChainId = Number(_originChainId);
    const destinationChainId = Number(_destinationChainId);
    const inputAmount = toBN(_inputAmount);
    const depositKey = getDepositKey(depositMessage);

    // Skip if a previous instance (or this one) already executed this deposit (persisted in Redis).
    if (this.executedDepositTxHashes.has(refTxHash)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateDeposit",
        message: "Skipping already executed deposit (found in Redis)",
        refTxHash,
        depositKey,
      });
      return;
    }

    if (this.observedExecutedDeposits[originChainId]?.has(depositKey)) {
      return;
    }

    this.observedExecutedDeposits[originChainId].add(depositKey);

    let isDepositAddressDeployed = false;
    try {
      isDepositAddressDeployed = await this.isContractDeployed(originChainId, depositMessage.depositAddress);
    } catch {
      this.observedExecutedDeposits[originChainId].delete(depositKey);
      this.logger.warn({
        at: "DepositAddressHandler#initiateDeposit",
        message: "Failed to check if deposit address is deployed",
        depositKey,
      });
      return;
    }

    const baseFactoryContract = this.counterfactualDepositFactories[originChainId];

    const useDispatcher = this.depositAddressSigners.length > 0;
    const factoryContract = useDispatcher
      ? baseFactoryContract
      : baseFactoryContract.connect(this.baseSigner.connect(this.providersByChain[originChainId]));

    // Before initiating any transactions, check if the deposit address has been credited with the
    // input token on the origin chain. If it has not, then we either (1) have already processed this
    // deposit, or (2) received a transaction from the indexer which has been reorged and will be processed
    // once the funds arrive to the deposit address.
    const inputTokenContract = new Contract(inputToken, ERC20_ABI, factoryContract.provider);
    const balanceOfContract = await inputTokenContract.balanceOf(depositMessage.depositAddress);
    if (balanceOfContract.lt(inputAmount)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateDeposit",
        message: "Contract does not have sufficient input token balance to initiate deposit.",
        depositKey,
        depositAddress: depositMessage.depositAddress,
        inputToken,
      });
      return;
    }

    if (!isDepositAddressDeployed) {
      const _deployTx = buildDeployTx(
        factoryContract,
        originChainId,
        getCounterfactualDepositImplementationAddress(originChainId),
        depositMessage.paramsHash,
        depositMessage.salt
      );

      const deployTx = {
        ..._deployTx,
        message: "Deposit Address Deployed Successfully 📦",
        mrkdwn: `Completed deployemnt of DepositAddress ${depositMessage.depositAddress} on ${getNetworkName(
          originChainId
        )}`,
      };

      const deployReceipt = await sendAndConfirmTransaction(deployTx, this.transactionClient, useDispatcher);
      if (!isDefined(deployReceipt)) {
        this.observedExecutedDeposits[originChainId].delete(depositKey);
        this.logger.warn({
          at: "DepositAddressHandler#initiateDeposit",
          message: "Failed to submit deploy tx",
          depositKey,
        });
        return;
      }
    }

    // At this point, the user's deposit contract is deployed on the origin network.
    const swapTx = await this._getSwapApiQuote(depositMessage);
    if (!isDefined(swapTx) || !swapTx.swapTx.simulationSuccess) {
      this.logger.warn({
        at: "DepositAddressHandler#initiateDeposit",
        message: "Failed to fetch swap tx from swap API",
        depositKey,
      });
      this.observedExecutedDeposits[originChainId].delete(depositKey);
      return;
    }

    const { data: executeTxInput } = swapTx.swapTx;
    const executeTx = {
      contract: this.getExecuteContract(swapTx.swapTx.to, originChainId, useDispatcher),
      method: "",
      args: [executeTxInput],
      chainId: originChainId,
      message: "Completed Deposit Execution Successfully 🎯",
      mrkdwn: `Completed execution of Deposit on ${getNetworkName(originChainId)} to ${getNetworkName(
        destinationChainId
      )}, using deposit address ${blockExplorerLink(depositMessage.depositAddress, originChainId)}`,
    };

    const depositReceipt = await sendAndConfirmTransaction(executeTx, this.transactionClient, useDispatcher);

    if (!depositReceipt) {
      this.logger.warn({
        at: "DepositAddressHandler#initiateDeposit",
        message: "Failed to submit execute tx",
        depositKey,
      });
      this.observedExecutedDeposits[originChainId].delete(depositKey);
      return;
    }

    // Persist full set to Redis immediately so handover cannot miss this execute.
    this.executedDepositTxHashes.add(refTxHash);
    await this._persistExecutedDepositsRedis();
  }

  private getExecuteContract(address: string, originChainId: number, useDispatcher: boolean): Contract {
    const contract = new Contract(address, []);
    return useDispatcher ? contract : contract.connect(this.baseSigner.connect(this.providersByChain[originChainId]));
  }

  /**
   * @notice Returns whether a contract exists at the given address on the given chain (eth_getCode).
   */
  private async isContractDeployed(chainId: number, address: string, blockTag?: string | number): Promise<boolean> {
    const provider = this.providersByChain[chainId];
    assert(isDefined(provider), `Provider not found for chain ${chainId}`);
    const code = await provider.getCode(address, blockTag ?? "latest");
    return (code?.length ?? 0) > 2; // "0x".length = 2;
  }

  /*
   * @notice Queries the Indexer API for all pending deposit addresses transactions. By default, do not retry since this endpoing is being polled.
   */
  private async _queryIndexerApi(retriesRemaining = 3): Promise<DepositAddressMessage[]> {
    let apiResponseData: DepositAddressMessage[] | undefined = undefined;
    try {
      apiResponseData = await this.indexerApi.get<DepositAddressMessage[]>(this.config.indexerApiEndpoint, {});
    } catch {
      // Error log should have been emitted in IndexerApiClient.
    }
    if (!isDefined(apiResponseData)) {
      return retriesRemaining > 0 ? this._queryIndexerApi(--retriesRemaining) : [];
    }
    return apiResponseData;
  }

  private async _getSwapApiQuote(
    depositMessage: DepositAddressMessage,
    retriesRemaining = 3
  ): Promise<SwapApiResponse | undefined> {
    const { depositAddress, routeParams, erc20Transfer } = depositMessage;
    const { inputToken, outputToken, originChainId, destinationChainId, recipient } = routeParams;
    const { amount } = erc20Transfer;
    const params = {
      originChainId,
      destinationChainId,
      inputToken,
      outputToken,
      tradeType: "exactInput", // Should be exactInput for counterfactual deposits.
      amount,
      depositor: depositAddress,
      recipient,
      depositAddress,
      executionFeeRecipient: this.signerAddress.toNative(),
    };
    try {
      return await this.api.get<SwapApiResponse>(this.config.apiEndpoint, params);
    } catch {
      // Logging should have been done in the swap api client, so we do not need to log here.
      return retriesRemaining > 0 ? this._getSwapApiQuote(depositMessage, --retriesRemaining) : undefined;
    }
  }
}
