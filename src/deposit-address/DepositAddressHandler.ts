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
  toBN,
  getDepositKey,
  assert,
  getCounterfactualDepositImplementationAddress,
} from "../utils";
import { DepositAddressMessage } from "../interfaces";
import { AcrossSwapApiClient, TransactionClient, SwapApiResponse } from "../clients";
import { AcrossIndexerApiClient } from "../clients/AcrossIndexerApiClient";
import ERC20_ABI from "../common/abi/MinimalERC20.json";

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
    const depositMessages = await this._queryIndexerApi();
    const filtered = depositMessages.filter((m) =>
      this.config.relayerOriginChains.includes(Number(m.routeParams.originChainId))
    );
    await forEachAsync(filtered, async (depositMessage) => {
      await this.initiateDeposit(depositMessage);
    });
  }

  private async initiateDeposit(depositMessage: DepositAddressMessage): Promise<void> {
    const { inputToken, originChainId: _originChainId } = depositMessage.routeParams;
    const { amount: _inputAmount } = depositMessage.erc20Transfer;
    const originChainId = Number(_originChainId);
    const inputAmount = toBN(_inputAmount);
    const depositKey = getDepositKey(depositMessage);
    if (this.observedExecutedDeposits[originChainId]?.has(depositKey)) {
      return;
    }

    this.observedExecutedDeposits[originChainId].add(depositKey);

    let isDepositAddressDeployed = false;
    try {
      isDepositAddressDeployed = await this.isContractDeployed(originChainId, depositMessage.depositAddress);
    } catch (err) {
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
      const deployTx = buildDeployTx(
        factoryContract,
        originChainId,
        getCounterfactualDepositImplementationAddress(originChainId),
        depositMessage.paramsHash,
        depositMessage.salt
      );
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
      contract: factoryContract,
      method: "",
      args: [executeTxInput],
      chainId: originChainId,
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
      depositor: depositAddress, // The depositor address should be the counterfactual deposit contract.
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
