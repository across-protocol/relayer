import winston from "winston";
import { DepositAddressHandlerConfig } from "./DepositAddressHandlerConfig";
import {
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
  getNetworkName,
  blockExplorerLink,
  BigNumber,
  normalizeDepositAddressMessage,
  toChainNativeAddress,
} from "../utils";
import { getRedisCache, RedisCacheInterface } from "../cache/Redis";
import { DepositAddressMessage } from "../interfaces";
import { AcrossSwapApiClient, TransactionClient, SwapApiResponse, SignedWithdrawResponse } from "../clients";
import { AcrossIndexerApiClient } from "../clients/AcrossIndexerApiClient";
import ERC20_ABI from "../common/abi/MinimalERC20.json";

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class DepositAddressHandler {
  private abortController = new AbortController();
  private _instanceCoordinator?: InstanceCoordinator;
  private initialized = false;

  // instanceCoordinator is populated by initialize(); reads pre-init throw, writes go through the setter.
  private get instanceCoordinator(): InstanceCoordinator {
    assert(
      isDefined(this._instanceCoordinator),
      "DepositAddressHandler: instanceCoordinator accessed before initialize()"
    );
    return this._instanceCoordinator;
  }
  private set instanceCoordinator(value: InstanceCoordinator) {
    this._instanceCoordinator = value;
  }

  private providersByChain: { [chainId: number]: Provider } = {};

  /** Per chainId: set of deposit keys already executed (like gasless depositNonces). */
  private observedExecutedDeposits: { [chainId: number]: Set<string> } = {};

  /** Set of erc20Transfer.transactionHash for deposits successfully executed (persisted in Redis for handover). */
  private executedDepositTxHashes: Set<string> = new Set();

  /** Set of depositKeys for refund withdraws successfully executed (persisted in Redis for handover). */
  private executedWithdrawKeys: Set<string> = new Set();

  /**
   * Per chainId (refund chain = erc20Transfer.chainId): set of depositKeys for withdraws currently
   * being processed in this run. Prevents the next poll (which can fire on a 1s interval, faster
   * than a withdraw confirms) from racing against an in-flight broadcast. Mirrors
   * `observedExecutedDeposits` on the deposit path.
   */
  private observedExecutedWithdraws: { [chainId: number]: Set<string> } = {};

  private api: AcrossSwapApiClient;
  private indexerApi: AcrossIndexerApiClient;
  private _signerAddress?: EvmAddress;

  // signerAddress is populated by initialize(); reads pre-init throw, writes go through the setter.
  private get signerAddress(): EvmAddress {
    assert(isDefined(this._signerAddress), "DepositAddressHandler: signerAddress accessed before initialize()");
    return this._signerAddress;
  }
  private set signerAddress(value: EvmAddress) {
    this._signerAddress = value;
  }

  private transactionClient;
  private redisCache: RedisCacheInterface | undefined;

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

    // Set the signer address.
    this.signerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.redisCache = await getRedisCache(this.logger);
    assert(isDefined(this.redisCache), "DepositAddressHandler: requires a Redis cache for handover state");

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
      this.observedExecutedDeposits[chainId] = new Set<string>();
      this.observedExecutedWithdraws[chainId] = new Set<string>();
    });

    // Establish bot instance and take over. First thing after handover: load persisted executed deposits from Redis.
    this.instanceCoordinator = new InstanceCoordinator(
      this.logger,
      this.redisCache,
      this.config.botIdentifier,
      this.config.runIdentifier,
      this.abortController
    );
    await this.instanceCoordinator.initiateHandover();

    await this._loadExecutedDepositsFromRedis();
    await this._loadWithdrawnKeysFromRedis();

    this.initialized = true;
  }

  private getExecutedDepositsRedisKey(): string {
    return `deposit-address:executed:${this.config.botIdentifier}`;
  }

  private getWithdrawnKeysRedisKey(): string {
    return `deposit-address:withdrawn-deposit-keys:${this.config.botIdentifier}`;
  }

  /** Loads executed deposit tx hashes from Redis (e.g. after handover). */
  private async _loadExecutedDepositsFromRedis(): Promise<void> {
    assert(isDefined(this.redisCache), "DepositAddressHandler: redisCache accessed before initialize()");
    const { redisCache } = this;
    const redisKey = this.getExecutedDepositsRedisKey();
    const raw = await redisCache.get<string>(redisKey);
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

  /** Loads executed refund-withdraw depositKeys from Redis (e.g. after handover). */
  private async _loadWithdrawnKeysFromRedis(): Promise<void> {
    assert(isDefined(this.redisCache), "DepositAddressHandler: redisCache accessed before initialize()");
    const { redisCache } = this;
    const redisKey = this.getWithdrawnKeysRedisKey();
    const raw = await redisCache.get<string>(redisKey);
    let arr: string[] = [];
    try {
      if (raw) {
        arr = parseJson.stringArray(raw);
      }
    } catch (err) {
      this.logger.error({
        at: "DepositAddressHandler#_loadWithdrawnKeysFromRedis",
        message: "Failed to parse withdrawn deposit keys from Redis, using empty set",
        redisKey,
        err: err instanceof Error ? err.message : String(err),
      });

      throw err;
    }
    this.executedWithdrawKeys = new Set(arr);
    this.logger.debug({
      at: "DepositAddressHandler#_loadWithdrawnKeysFromRedis",
      message: "Loaded executed withdraw deposit keys from Redis",
      count: this.executedWithdrawKeys.size,
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

    // We want to remove all executed deposits from the in-memory set if they are not returned by the indexer.
    // This is because the indexer will stop sending the deposit once it has been "expired" (internal TTL).
    // So there is no point of keeping them in Redis after Indexer API stops returning them.
    const refTxHashesFromIndexer = new Set(depositMessages.map((m) => m.erc20Transfer.transactionHash));
    const depositKeysFromIndexer = new Set(depositMessages.map((m) => getDepositKey(m)));
    for (const tx of [...this.executedDepositTxHashes]) {
      if (!refTxHashesFromIndexer.has(tx)) {
        this.executedDepositTxHashes.delete(tx);
      }
    }
    for (const key of [...this.executedWithdrawKeys]) {
      if (!depositKeysFromIndexer.has(key)) {
        this.executedWithdrawKeys.delete(key);
      }
    }

    await forEachAsync(depositMessages, async (depositMessage) => {
      await this.processExecution(depositMessage);
    });
  }

  /**
   * Dispatches an indexer message to the deposit or refund-withdraw path based on its classification:
   *   - correct_transfer: forward deposit/execute path.
   *   - mis_route / intent_refund: refund-withdraw path.
   *   - anything else: dropped (forward-compat) until explicitly supported.
   */
  private async processExecution(depositMessage: DepositAddressMessage): Promise<void> {
    const classification = depositMessage.erc20Transfer.transferClassification;
    if (classification === "correct_transfer") {
      return this.initiateDeposit(depositMessage);
    }
    if (classification === "mis_route" || classification === "intent_refund") {
      return this.initiateWithdraw(depositMessage);
    }
    this.logger.debug({
      at: "DepositAddressHandler#processExecution",
      message: "deposit-address transfer skipped: unknown classification",
      classification,
      depositAddress: depositMessage.depositAddress,
      paramsHash: depositMessage.paramsHash,
      txHash: depositMessage.erc20Transfer.transactionHash,
      chainId: depositMessage.erc20Transfer.chainId,
    });
  }

  /**
   * @notice Refund-withdraw path entry point. Gated behind config.withdrawEnabled.
   * Refunds the full transfer amount via the quote-api signed-withdraw flow; gas-reserve / fee
   * deduction is deferred to a follow-up task. The quote-api response bundles the
   * counterfactual-deposit deploy + signedWithdrawToUser into a single Multicall3 call when the
   * deposit clone is not yet on-chain, so the bot does not need its own deploy step.
   */
  private async initiateWithdraw(depositMessage: DepositAddressMessage): Promise<void> {
    const { erc20Transfer, depositAddress, paramsHash } = depositMessage;
    const {
      transactionHash: refTxHash,
      contractAddress: token,
      amount,
      transferClassification: classification,
    } = erc20Transfer;
    // Refund chain is where funds landed (NOT routeParams.originChainId — for mis_routes those differ).
    const chainId = Number(erc20Transfer.chainId);
    const depositKey = getDepositKey(depositMessage);

    // Drop refund-withdraws while the gate is closed. intent_refund in particular would re-loop the
    // same intent if forwarded down the deposit path, so we cannot fall back to initiateDeposit.
    if (!this.config.withdrawEnabled) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateWithdraw",
        message: "deposit-address transfer skipped: withdraw flow disabled",
        classification,
        depositAddress,
        paramsHash,
        txHash: refTxHash,
        chainId,
      });
      return;
    }

    if (!this.config.relayerOriginChains.includes(chainId)) {
      return;
    }

    // Skip if a previous instance (or this one) already executed this withdraw (persisted in Redis).
    if (this.executedWithdrawKeys.has(depositKey)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateWithdraw",
        message: "Skipping already executed withdraw (found in Redis)",
        refTxHash,
        depositKey,
      });
      return;
    }

    if (this.observedExecutedWithdraws[chainId]?.has(depositKey)) {
      return;
    }

    this.observedExecutedWithdraws[chainId].add(depositKey);
    // Release the in-flight lock on every exit path except a confirmed on-chain withdraw; an
    // unexpected throw must not strand the depositKey, since the next poll would silently skip it.
    let withdrawCommitted = false;
    try {
      // Defensive on-chain balance check — guards against reorged indexer messages and against
      // acting on a deposit-address that has already been withdrawn through another path.
      const provider = this.providersByChain[chainId];
      const tokenContract = new Contract(token, ERC20_ABI, provider);

      let onchainBalance: BigNumber;
      try {
        onchainBalance = await tokenContract.balanceOf(depositAddress);
      } catch (err) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdraw",
          message: "Skipping withdraw: failed to fetch deposit address balance",
          depositAddress,
          token,
          depositKey,
          refTxHash,
          chainId,
          err: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (onchainBalance.lt(toBN(amount))) {
        this.logger.debug({
          at: "DepositAddressHandler#initiateWithdraw",
          message: "Skipping withdraw: deposit address balance below transfer amount",
          depositAddress,
          token,
          amount,
          onchainBalance: onchainBalance.toString(),
          depositKey,
          refTxHash,
          chainId,
        });
        return;
      }

      const signed = await this._getSignedWithdraw(depositMessage);
      if (!isDefined(signed)) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdraw",
          message: "Failed to fetch signed withdraw from quote-api",
          depositKey,
          refTxHash,
          depositAddress,
          chainId,
        });
        return;
      }

      if (signed.signedWithdrawTx.chainId !== chainId) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdraw",
          message: "Skipping withdraw: signed payload chainId does not match refund chainId",
          signedChainId: signed.signedWithdrawTx.chainId,
          chainId,
          depositKey,
          refTxHash,
          depositAddress,
        });
        return;
      }

      const useDispatcher = this.depositAddressSigners.length > 0;
      const withdrawTx = {
        contract: this.getExecuteContract(signed.signedWithdrawTx.to, chainId, useDispatcher),
        method: "",
        args: [signed.signedWithdrawTx.data],
        value: toBN(signed.signedWithdrawTx.value),
        chainId,
        message: "Completed Refund Withdraw 💸",
        mrkdwn: `Refund withdraw on ${getNetworkName(chainId)} for deposit address ${blockExplorerLink(
          depositAddress,
          chainId
        )} (classification: ${erc20Transfer.transferClassification}, bundledDeploy: ${signed.bundledDeploy})`,
      };

      const receipt = await sendAndConfirmTransaction(withdrawTx, this.transactionClient, useDispatcher);
      if (!isDefined(receipt)) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdraw",
          message: "Failed to submit withdraw tx",
          depositKey,
          refTxHash,
          depositAddress,
          chainId,
        });
        return;
      }

      // The withdraw is on-chain; keep the in-flight lock and never re-attempt this depositKey,
      // even if the Redis persist below throws (handover may miss it, but a double-send is worse).
      this.executedWithdrawKeys.add(depositKey);
      withdrawCommitted = true;
      await this._persistWithdrawnKeysRedis();
    } finally {
      if (!withdrawCommitted) {
        this.observedExecutedWithdraws[chainId].delete(depositKey);
      }
    }
  }

  private async _getSignedWithdraw(
    depositMessage: DepositAddressMessage,
    retriesRemaining = 3
  ): Promise<SignedWithdrawResponse | undefined> {
    const { erc20Transfer, routeParams, depositAddress, paramsHash, salt, counterfactualMaterials } = depositMessage;
    const { contractAddress: token, amount, chainId } = erc20Transfer;
    // @TODO: some old indexer messages may not have counterfactual materials, so we need to handle that for some time.
    // We should remove this once we have migrated all indexer messages to the new format.
    const withdrawLeaf = counterfactualMaterials?.withdrawLeaf;
    if (
      !isDefined(withdrawLeaf) ||
      !isDefined(withdrawLeaf.implementationAddress) ||
      !isDefined(withdrawLeaf.merkleProof)
    ) {
      this.logger.warn({
        at: "DepositAddressHandler#_getSignedWithdraw",
        message: "Skipping withdraw: indexer message missing counterfactual withdraw materials",
        depositAddress,
        paramsHash,
        txHash: erc20Transfer.transactionHash,
        chainId,
      });
      return undefined;
    }
    // `_post` swallows errors and returns undefined, so retry on both throw and falsy return.
    try {
      const result = await this.api.signedWithdraw({
        chainId: Number(chainId),
        depositAddress,
        token,
        amount,
        user: routeParams.refundAddress,
        withdrawImplementation: withdrawLeaf.implementationAddress,
        proof: withdrawLeaf.merkleProof,
        salt,
        merkleRoot: paramsHash,
      });
      if (result) {
        return result;
      }
    } catch {
      // Logging is handled in AcrossSwapApiClient.
    }
    return retriesRemaining > 0 ? this._getSignedWithdraw(depositMessage, --retriesRemaining) : undefined;
  }

  /**
   * Overwrites Redis key with the full executedDepositTxHashes set (single SET; value is JSON array).
   * Called at start of each poll (after filtering) and after each successful execute.
   */
  private async _persistExecutedDepositsRedis(): Promise<void> {
    assert(isDefined(this.redisCache), "DepositAddressHandler: redisCache accessed before initialize()");
    const { redisCache } = this;
    const redisKey = this.getExecutedDepositsRedisKey();
    await redisCache.set(redisKey, JSON.stringify([...this.executedDepositTxHashes]));
  }

  /** Same pattern as `_persistExecutedDepositsRedis` but for refund-withdraw deposit keys. */
  private async _persistWithdrawnKeysRedis(): Promise<void> {
    assert(isDefined(this.redisCache), "DepositAddressHandler: redisCache accessed before initialize()");
    const { redisCache } = this;
    const redisKey = this.getWithdrawnKeysRedisKey();
    await redisCache.set(redisKey, JSON.stringify([...this.executedWithdrawKeys]));
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

    if (!this.config.relayerOriginChains.includes(originChainId)) {
      return;
    }

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

    const baseFactoryContract = getCounterfactualDepositFactory(
      depositMessage.counterfactualFactoryContractAddress
    ).connect(this.providersByChain[originChainId]);

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
        depositMessage.counterfactualDepositContractAddress,
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
          deployTx: {
            ...deployTx,
            contract: deployTx.contract.address,
          },
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
        executeTx: {
          ...executeTx,
          contract: executeTx.contract.address,
        },
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
    return apiResponseData.map(normalizeDepositAddressMessage);
  }

  private async _getSwapApiQuote(
    depositMessage: DepositAddressMessage,
    retriesRemaining = 3
  ): Promise<SwapApiResponse | undefined> {
    const { depositAddress, routeParams, erc20Transfer } = depositMessage;
    const { inputToken, outputToken, originChainId, destinationChainId, recipient, refundAddress } = routeParams;
    const { amount } = erc20Transfer;
    const originChainIdNum = Number(originChainId);
    // Swap API expects Tron origin fields in base58; on-chain paths keep ethers `0x` via normalizeDepositAddressMessage.
    // refundAddress must match what was committed in the withdraw leaf at PDA creation time so the
    // swap-api rebuilds the same merkle root the on-chain factory derives the deposit address from.
    const params = {
      originChainId,
      destinationChainId,
      inputToken: toChainNativeAddress(originChainIdNum, inputToken),
      outputToken,
      tradeType: "exactInput", // Should be exactInput for counterfactual deposits.
      amount,
      depositor: toChainNativeAddress(originChainIdNum, depositAddress),
      recipient,
      refundAddress: toChainNativeAddress(originChainIdNum, refundAddress),
      depositAddress: toChainNativeAddress(originChainIdNum, depositAddress),
      executionFeeRecipient: toChainNativeAddress(originChainIdNum, this.signerAddress.toNative()),
      shouldSponsorAccountCreation: String(depositMessage.shouldSponsorAccountCreation),
    };
    try {
      return await this.api.get<SwapApiResponse>(this.config.apiEndpoint, params);
    } catch {
      // Logging should have been done in the swap api client, so we do not need to log here.
      return retriesRemaining > 0 ? this._getSwapApiQuote(depositMessage, --retriesRemaining) : undefined;
    }
  }
}
