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
  toAddressType,
  TransactionReceipt,
  getCurrentTime,
  isHttpError,
} from "../utils";
import { getRedisCache, RedisCacheInterface } from "../cache/Redis";
import {
  AnyDepositAddressMessage,
  CounterfactualMaterialV3,
  DepositAddressMessage,
  DepositAddressMessageV3,
  isDepositAddressMessageV3,
} from "../interfaces";
import {
  AcrossSwapApiClient,
  TransactionClient,
  SwapApiResponse,
  SignedWithdrawResponse,
  DepositAddressExecuteResponse,
  DepositAddressSignWithdrawResponse,
} from "../clients";
import { AcrossIndexerApiClient } from "../clients/AcrossIndexerApiClient";
import { GcpPubSubPublisher, getGcpPubSubPublisher } from "../messaging/gcp";
import { buildDepositExecutedPayload, buildWithdrawExecutedPayload } from "./withdrawPayload";
import ERC20_ABI from "../common/abi/MinimalERC20.json";

/**
 * Minimum seconds that must remain on a v3 execute response's signatureDeadline at submission
 * time — headroom for simulation, broadcast and confirmation. Responses closer to expiry are
 * dropped and re-requested fresh on the next poll.
 */
const V3_SIGNATURE_DEADLINE_BUFFER = 60;

/** Quote-api execute requires a 2-byte-hex integratorId; mirror its schema regex. */
const INTEGRATOR_ID_REGEX = /^0x[0-9a-fA-F]{4}$/;

/**
 * Indexer message versions the bot knows how to execute. Anything else (e.g. v2, or a future
 * version shipped on the indexer before the bot supports it) is dropped before normalization —
 * an allowlist, not a v2 denylist, so an unknown shape can never reach normalizeDepositAddressMessage
 * and sink the whole poll batch.
 */
const SUPPORTED_INDEXER_MESSAGE_VERSIONS = new Set([1, 3]);

/**
 * Cap on each watchdog heartbeat request. `fetch` has no default timeout, and the scheduler
 * fires every ping fire-and-forget — without a cap, a hung heartbeat endpoint would stack
 * pending requests indefinitely.
 */
const HEARTBEAT_TIMEOUT_MS = 5_000;

// Warn on every Nth consecutive heartbeat failure (i.e. once per N ticks during a sustained
// outage, rather than once per tick or once ever).
const HEARTBEAT_FAILURE_WARN_THRESHOLD = 10;

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class DepositAddressHandler {
  private abortController = new AbortController();
  private _instanceCoordinator?: InstanceCoordinator;
  private initialized = false;
  private consecutiveHeartbeatFailures = 0;

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
   * Set of depositKeys for v3 refund withdraws the quote-api rejected with a terminal 422
   * (`GAS_EXCEEDS_REFUND` / `UNPRICEABLE_REFUND_TOKEN`). Persisted in Redis so the skip survives
   * handover and is not re-attempted on later polls. Pruned alongside the other sets once the
   * indexer stops returning the source message.
   */
  private terminallySkippedWithdrawKeys: Set<string> = new Set();

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
  // Single client shared by both lifecycle events (withdraw_executed / deposit_executed); they
  // publish to the same topic and project. Per-event emission is gated by the respective config flag.
  private executionPublisher: GcpPubSubPublisher | undefined;

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

    if (this.config.enableDepositAddressWithdrawPublisher || this.config.enableDepositAddressDepositPublisher) {
      this.executionPublisher = getGcpPubSubPublisher(this.logger, this.config.pubSubGcpProjectId);
    }

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
    await this._loadSkippedWithdrawKeysFromRedis();

    this.initialized = true;
  }

  private getExecutedDepositsRedisKey(): string {
    return `deposit-address:executed:${this.config.botIdentifier}`;
  }

  private getWithdrawnKeysRedisKey(): string {
    return `deposit-address:withdrawn-deposit-keys:${this.config.botIdentifier}`;
  }

  private getSkippedWithdrawKeysRedisKey(): string {
    return `deposit-address:skipped-withdraw-keys:${this.config.botIdentifier}`;
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

  /** Loads terminally-skipped (422) refund-withdraw depositKeys from Redis (e.g. after handover). */
  private async _loadSkippedWithdrawKeysFromRedis(): Promise<void> {
    assert(isDefined(this.redisCache), "DepositAddressHandler: redisCache accessed before initialize()");
    const { redisCache } = this;
    const redisKey = this.getSkippedWithdrawKeysRedisKey();
    const raw = await redisCache.get<string>(redisKey);
    let arr: string[] = [];
    try {
      if (raw) {
        arr = parseJson.stringArray(raw);
      }
    } catch (err) {
      this.logger.error({
        at: "DepositAddressHandler#_loadSkippedWithdrawKeysFromRedis",
        message: "Failed to parse skipped withdraw keys from Redis, using empty set",
        redisKey,
        err: err instanceof Error ? err.message : String(err),
      });

      throw err;
    }
    this.terminallySkippedWithdrawKeys = new Set(arr);
    this.logger.debug({
      at: "DepositAddressHandler#_loadSkippedWithdrawKeysFromRedis",
      message: "Loaded terminally-skipped withdraw deposit keys from Redis",
      count: this.terminallySkippedWithdrawKeys.size,
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
    scheduleTask(() => this.kickWatchdog(), this.config.watchdogInterval, this.abortController.signal);
  }

  /**
   * Dead-man's-switch heartbeat, kicked externally by the `watchdogInterval` scheduler in
   * pollAndExecute() (default 15s) until the handler's abortController fires on
   * handover/shutdown. With a Checkly period of 30s + grace of 30s, a dead bot trips the alert
   * within ~60s; cadence << period, so a dropped ping is fine. Best-effort: a heartbeat failure
   * must never disrupt the bot, but sustained failures are logged since the alert will fire and
   * this log is the first place to look for the cause.
   */
  private async kickWatchdog(): Promise<void> {
    const url = this.config.heartbeatUrl;
    if (!url) {
      return;
    }

    let failure: string;
    try {
      const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
      if (response.ok) {
        this.consecutiveHeartbeatFailures = 0;
        return;
      }
      failure = `HTTP ${response.status}`;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    if (++this.consecutiveHeartbeatFailures % HEARTBEAT_FAILURE_WARN_THRESHOLD === 0) {
      this.logger.warn({
        at: "DepositAddressHandler#kickWatchdog",
        message: "Sustained watchdog heartbeat failures",
        consecutiveFailures: this.consecutiveHeartbeatFailures,
        lastError: failure,
      });
    }
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
    for (const key of [...this.terminallySkippedWithdrawKeys]) {
      if (!depositKeysFromIndexer.has(key)) {
        this.terminallySkippedWithdrawKeys.delete(key);
      }
    }

    await forEachAsync(depositMessages, async (depositMessage) => {
      await this.processExecution(depositMessage);
    });
  }

  /**
   * Dispatches an indexer message to the deposit or refund-withdraw path based on its version and
   * classification:
   *   - v3 correct_transfer: thin-submitter execute path (initiateDepositV3).
   *   - v3 mis_route: refund-withdraw path (initiateWithdrawV3), gated behind config.enableV3Withdrawals.
   *   - v3 anything else (incl. intent_refund): dropped — not yet supported on v3.
   *   - v1 correct_transfer: forward deposit/execute path.
   *   - v1 mis_route / intent_refund: refund-withdraw path.
   *   - anything else: dropped (forward-compat) until explicitly supported.
   */
  private async processExecution(depositMessage: AnyDepositAddressMessage): Promise<void> {
    const classification = depositMessage.erc20Transfer.transferClassification;
    if (isDepositAddressMessageV3(depositMessage)) {
      if (classification === "correct_transfer") {
        return this.initiateDepositV3(depositMessage);
      }
      if (classification === "mis_route") {
        return this.initiateWithdrawV3(depositMessage);
      }
      this.logger.debug({
        at: "DepositAddressHandler#processExecution",
        message: "deposit-address transfer skipped: v3 refund-withdraw not supported for classification",
        classification,
        depositAddress: depositMessage.depositAddress,
        txHash: depositMessage.erc20Transfer.transactionHash,
        chainId: depositMessage.erc20Transfer.chainId,
      });
      return;
    }
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
   * Refunds the max of the indexer-reported transfer amount and the deposit address's on-chain
   * balance via the quote-api signed-withdraw flow; gas-reserve / fee deduction is deferred to a
   * follow-up task. The quote-api response bundles the
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

      if (onchainBalance.lt(this.config.minSweepAmount)) {
        this.logger.debug({
          at: "DepositAddressHandler#initiateWithdraw",
          message: "Skipping withdraw: deposit address balance below min transfer amount",
          depositAddress,
          token,
          amount,
          onchainBalance: onchainBalance.toString(),
          depositKey,
          refTxHash,
          chainId,
          min: this.config.minSweepAmount,
        });
        return;
      }

      const sweepAmount = this._getSweepAmount(amount, onchainBalance, {
        at: "DepositAddressHandler#initiateWithdraw",
        depositAddress,
        token,
        depositKey,
        refTxHash,
        chainId,
      });

      const signed = await this._getSignedWithdraw(depositMessage, sweepAmount);
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
      await this._publishWithdrawExecuted(receipt, depositMessage);
    } finally {
      if (!withdrawCommitted) {
        this.observedExecutedWithdraws[chainId].delete(depositKey);
      }
    }
  }

  private async _getSignedWithdraw(
    depositMessage: DepositAddressMessage,
    sweepAmount: string,
    retriesRemaining = 3
  ): Promise<SignedWithdrawResponse | undefined> {
    const { erc20Transfer, routeParams, depositAddress, paramsHash, salt, counterfactualMaterials } = depositMessage;
    const { contractAddress: token, chainId } = erc20Transfer;
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
        amount: sweepAmount,
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
    return retriesRemaining > 0 ? this._getSignedWithdraw(depositMessage, sweepAmount, --retriesRemaining) : undefined;
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

  /** Same pattern as `_persistWithdrawnKeysRedis` but for terminally-skipped (422) withdraw keys. */
  private async _persistSkippedWithdrawKeysRedis(): Promise<void> {
    assert(isDefined(this.redisCache), "DepositAddressHandler: redisCache accessed before initialize()");
    const { redisCache } = this;
    const redisKey = this.getSkippedWithdrawKeysRedisKey();
    await redisCache.set(redisKey, JSON.stringify([...this.terminallySkippedWithdrawKeys]));
  }

  /**
   * Best-effort publish of a `withdraw_executed` lifecycle event to GCP Pub/Sub. Payload shape
   * is locked by the consumer (`isDepositAddressWithdrawPayload` in
   * `indexer/packages/indexer/src/pubsub/DepositAddressWithdrawConsumer.ts`).
   *
   * The withdraw is already on-chain by the time we get here; a publish failure never rolls
   * back state and never throws to the caller. The downside is that a dropped publish leaves
   * the indexer row in `auto_pending` — accepted trade-off for v1, see the module README.
   */
  private async _publishWithdrawExecuted(
    receipt: TransactionReceipt,
    depositMessage: AnyDepositAddressMessage
  ): Promise<void> {
    // The client may exist because the deposit gate is on; keep withdraw publishing independent.
    if (!this.config.enableDepositAddressWithdrawPublisher || !isDefined(this.executionPublisher)) {
      return;
    }
    const payload = buildWithdrawExecutedPayload(receipt, depositMessage);
    if (!isDefined(payload)) {
      const refundAddress = isDepositAddressMessageV3(depositMessage)
        ? depositMessage.refundAddress.address
        : depositMessage.routeParams.refundAddress;
      this.logger.warn({
        at: "DepositAddressHandler#_publishWithdrawExecuted",
        message: "Skipping publish: no ERC20 Transfer (deposit address → refund address) found in receipt",
        depositAddress: depositMessage.depositAddress,
        refundAddress,
        token: depositMessage.erc20Transfer.contractAddress,
        txHash: receipt.transactionHash,
      });
      return;
    }

    try {
      const messageId = await this.executionPublisher.publishJson(
        this.config.pubSubDepositAddressWithdrawTopic,
        payload
      );
      this.logger.debug({
        at: "DepositAddressHandler#_publishWithdrawExecuted",
        message: "Published withdraw_executed",
        messageId,
        payload,
      });
    } catch (err) {
      this.logger.error({
        at: "DepositAddressHandler#_publishWithdrawExecuted",
        message: "Failed to publish withdraw_executed to GCP Pub/Sub",
        topic: this.config.pubSubDepositAddressWithdrawTopic,
        payload,
        err: err instanceof Error ? err.message : String(err),
        notificationPath: "across-bot-error",
      });
    }
  }

  /**
   * Best-effort publish of a `deposit_executed` lifecycle event to GCP Pub/Sub after a successful
   * v3 deposit (correct-transfer) execution. Mirrors {@link _publishWithdrawExecuted}: the deposit
   * is already on-chain and Redis-persisted by the time we get here, so a publish failure never
   * rolls back state and never throws to the caller — a dropped publish leaves the indexer row
   * pending until ops reconciles. Shares the topic with `withdraw_executed`; gated independently by
   * config.enableDepositAddressDepositPublisher.
   *
   * Skipped entirely when `enableExecuteErc20Transfer` is on: that mode has the API emit a
   * version-2 provenance blob on-chain (via `AcrossEventEmitter`) linking the execute to the
   * funding transfer, so the indexer already learns of the execution from chain events and the
   * Pub/Sub event would be a redundant second signal for the same transition.
   */
  private async _publishDepositExecuted(
    receipt: TransactionReceipt,
    depositMessage: DepositAddressMessageV3
  ): Promise<void> {
    if (this.config.enableExecuteErc20Transfer) {
      this.logger.debug({
        at: "DepositAddressHandler#_publishDepositExecuted",
        message: "Skipping deposit_executed publish: on-chain erc20Transfer provenance metadata is enabled",
        depositAddress: depositMessage.depositAddress,
        txHash: receipt.transactionHash,
      });
      return;
    }
    if (!this.config.enableDepositAddressDepositPublisher || !isDefined(this.executionPublisher)) {
      return;
    }
    const payload = buildDepositExecutedPayload(receipt, depositMessage);
    if (!isDefined(payload)) {
      this.logger.warn({
        at: "DepositAddressHandler#_publishDepositExecuted",
        message: "Skipping publish: no ERC20 Transfer of the input token leaving the deposit address found in receipt",
        depositAddress: depositMessage.depositAddress,
        token: depositMessage.erc20Transfer.contractAddress,
        txHash: receipt.transactionHash,
      });
      return;
    }

    try {
      const messageId = await this.executionPublisher.publishJson(
        this.config.pubSubDepositAddressWithdrawTopic,
        payload
      );
      this.logger.debug({
        at: "DepositAddressHandler#_publishDepositExecuted",
        message: "Published deposit_executed",
        messageId,
        payload,
      });
    } catch (err) {
      this.logger.error({
        at: "DepositAddressHandler#_publishDepositExecuted",
        message: "Failed to publish deposit_executed to GCP Pub/Sub",
        topic: this.config.pubSubDepositAddressWithdrawTopic,
        payload,
        err: err instanceof Error ? err.message : String(err),
        notificationPath: "across-bot-error",
      });
    }
  }

  /** Releases the Pub/Sub client. Idempotent. Safe to call when the publisher is not configured. */
  public async disconnect(): Promise<void> {
    if (isDefined(this.executionPublisher)) {
      await this.executionPublisher.close();
      this.executionPublisher = undefined;
    }
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
    // Committed execution fees forwarded to the swap API (see _getSwapApiQuote). Surfaced in the
    // logs below so a merkle-mismatch quote failure is diagnosable; "omitted" means the leaf carried
    // no fee (legacy/pre-fee address) and the bot sent no fee param for it.
    const cctpExecutionFee = depositMessage.counterfactualMaterials?.cctpLeaf?.params?.executionFee ?? "omitted";
    const spokePoolExecutionFee =
      depositMessage.counterfactualMaterials?.spokePoolLeaf?.params?.executionFee ?? "omitted";

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

    const sweepAmount = this._getSweepAmount(_inputAmount, balanceOfContract, {
      at: "DepositAddressHandler#initiateDeposit",
      depositAddress: depositMessage.depositAddress,
      inputToken,
      depositKey,
      refTxHash,
      chainId: originChainId,
    });

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
    const swapTx = await this._getSwapApiQuote(depositMessage, sweepAmount);
    if (!isDefined(swapTx) || !swapTx.swapTx.simulationSuccess) {
      this.logger.warn({
        at: "DepositAddressHandler#initiateDeposit",
        message: "Failed to fetch swap tx from swap API",
        depositKey,
        cctpExecutionFee,
        spokePoolExecutionFee,
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
      )}, using deposit address ${blockExplorerLink(
        depositMessage.depositAddress,
        originChainId
      )} (cctpExecutionFee: ${cctpExecutionFee}, spokePoolExecutionFee: ${spokePoolExecutionFee})`,
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

  /**
   * v3 (upgradeable-counterfactual) deposit-execute path. The bot is a thin submitter: it relays
   * funding context to the quote-api execute endpoint, which re-derives the deposit address and
   * merkle materials server-side and returns ready-to-sign factory calldata wrapping
   * `deployIfNeededAndExecute` — so unlike v1 there is no bot-side deploy step. The returned
   * calldata embeds a deadline-bounded signature: it is perishable and is re-requested fresh on
   * the next poll after any failure, never patched.
   */
  private async initiateDepositV3(depositMessage: DepositAddressMessageV3): Promise<void> {
    const { depositAddress, routeParams, refundAddress, erc20Transfer, depositAddressNamespace } = depositMessage;
    const { amount, transactionHash: refTxHash, contractAddress: inputToken } = erc20Transfer;
    const originChainId = Number(erc20Transfer.chainId);
    const destinationChainId = Number(routeParams.destinationChainId);
    const depositKey = getDepositKey(depositMessage);

    if (!this.config.relayerOriginChains.includes(originChainId)) {
      return;
    }

    // Skip if a previous instance (or this one) already executed this deposit (persisted in Redis).
    if (this.executedDepositTxHashes.has(refTxHash)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateDepositV3",
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
    // Release the in-flight lock on every exit path except a confirmed on-chain execute; an
    // unexpected throw must not strand the depositKey, since the next poll would silently skip it.
    let executeCommitted = false;
    try {
      // The execute endpoint identity (userAddress) must be an EVM address; non-EVM identities
      // cannot be executed through this path.
      if (depositAddressNamespace !== "evm" || refundAddress.namespace !== "evm") {
        this.logger.warn({
          at: "DepositAddressHandler#initiateDepositV3",
          message: "Skipping v3 deposit: unsupported account namespace",
          depositAddressNamespace,
          refundAddressNamespace: refundAddress.namespace,
          depositAddress,
          refTxHash,
          chainId: originChainId,
        });
        return;
      }

      // The execute endpoint requires the integratorId (2-byte hex) that the deposit address was
      // derived with — it folds into the CREATE2 salt server-side. No funded v3 addresses exist
      // pre-integrator, so a missing/malformed value is a data anomaly: skip rather than guess one,
      // which would only derive (and execute at) a different, unfunded address.
      const integratorId = depositMessage.integrator?.integratorId;
      if (!isDefined(integratorId) || !INTEGRATOR_ID_REGEX.test(integratorId)) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateDepositV3",
          message: "Skipping v3 deposit: missing or malformed integratorId",
          integratorId: integratorId ?? "absent",
          depositAddress,
          refTxHash,
          chainId: originChainId,
        });
        return;
      }

      // Defensive on-chain balance check — guards against reorged indexer messages and against
      // acting on a deposit-address that has already been executed through another path.
      const inputTokenContract = new Contract(inputToken, ERC20_ABI, this.providersByChain[originChainId]);
      const onchainBalance: BigNumber = await inputTokenContract.balanceOf(depositAddress);
      if (onchainBalance.lt(this.config.minSweepAmount)) {
        this.logger.debug({
          at: "DepositAddressHandler#initiateDepositV3",
          message: "Deposit address does not have sufficient input token balance to initiate deposit.",
          depositKey,
          depositAddress,
          inputToken,
          amount,
          onchainBalance: onchainBalance.toString(),
          min: this.config.minSweepAmount,
        });
        return;
      }

      const sweepAmount = this._getSweepAmount(amount, onchainBalance, {
        at: "DepositAddressHandler#initiateDepositV3",
        depositAddress,
        inputToken,
        depositKey,
        refTxHash,
        chainId: originChainId,
      });

      const executeResponse = await this._getExecuteTx(depositMessage, sweepAmount);
      if (!isDefined(executeResponse)) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateDepositV3",
          message: "Failed to fetch execute tx from swap API",
          depositKey,
          depositAddress,
          chainId: originChainId,
        });
        return;
      }
      if (!this._validateExecuteResponse(executeResponse, depositMessage, originChainId, depositKey)) {
        return;
      }

      const { executeTx: apiExecuteTx } = executeResponse;
      const useDispatcher = this.depositAddressSigners.length > 0;
      const executeTx = {
        contract: this.getExecuteContract(apiExecuteTx.to, originChainId, useDispatcher),
        method: "",
        args: [apiExecuteTx.data],
        value: toBN(apiExecuteTx.value),
        chainId: originChainId,
        message: "Completed Deposit Execution Successfully 🎯",
        mrkdwn: `Completed execution of v3 Deposit on ${getNetworkName(originChainId)} to ${getNetworkName(
          destinationChainId
        )}, using deposit address ${blockExplorerLink(depositAddress, originChainId)}`,
      };

      const depositReceipt = await sendAndConfirmTransaction(executeTx, this.transactionClient, useDispatcher);
      if (!isDefined(depositReceipt)) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateDepositV3",
          message: "Failed to submit execute tx",
          depositKey,
          executeTx: {
            ...executeTx,
            contract: executeTx.contract.address,
          },
        });
        return;
      }

      // The execute is on-chain; keep the in-flight lock and persist to Redis immediately so
      // handover cannot miss this execute.
      this.executedDepositTxHashes.add(refTxHash);
      executeCommitted = true;
      await this._persistExecutedDepositsRedis();
      await this._publishDepositExecuted(depositReceipt, depositMessage);
    } finally {
      if (!executeCommitted) {
        this.observedExecutedDeposits[originChainId].delete(depositKey);
      }
    }
  }

  /**
   * Sanity-checks an execute response before submission. Most importantly, the API's re-derived
   * deposit address must match the funded address from the indexer — a mismatch means the API
   * would deploy/execute at a different address than the one holding the user's funds.
   */
  private _validateExecuteResponse(
    executeResponse: DepositAddressExecuteResponse,
    depositMessage: DepositAddressMessageV3,
    originChainId: number,
    depositKey: string
  ): boolean {
    const { depositAddress } = depositMessage;
    const { executeTx, isPlaceholder, signatureDeadline } = executeResponse;
    const logContext = {
      at: "DepositAddressHandler#initiateDepositV3",
      depositKey,
      depositAddress,
      chainId: originChainId,
    };

    if (executeResponse.depositAddress.toLowerCase() !== depositAddress.toLowerCase()) {
      this.logger.warn({
        ...logContext,
        message: "Skipping execute: API-derived deposit address does not match funded deposit address",
        apiDepositAddress: executeResponse.depositAddress,
      });
      return false;
    }
    if (executeTx.chainId !== originChainId) {
      this.logger.warn({
        ...logContext,
        message: "Skipping execute: execute tx chainId does not match origin chainId",
        executeTxChainId: executeTx.chainId,
      });
      return false;
    }
    if (isPlaceholder) {
      this.logger.warn({
        ...logContext,
        message: "Skipping execute: API derivation used placeholder creation code",
      });
      return false;
    }
    // The embedded signature is deadline-bounded; leave headroom for simulation + broadcast +
    // confirmation. A stale response is dropped and re-requested fresh on the next poll.
    if (signatureDeadline < getCurrentTime() + V3_SIGNATURE_DEADLINE_BUFFER) {
      this.logger.warn({
        ...logContext,
        message: "Skipping execute: signature deadline too close to expiry",
        signatureDeadline,
      });
      return false;
    }
    return true;
  }

  private async _getExecuteTx(
    depositMessage: DepositAddressMessageV3,
    sweepAmount: string,
    retriesRemaining = 3
  ): Promise<DepositAddressExecuteResponse | undefined> {
    const { routeParams, refundAddress, erc20Transfer } = depositMessage;
    // The API re-derives the deposit address and merkle materials from this identity; the bot
    // relays funding context plus the integratorId the address was derived with (≠ building
    // calldata). executionFee is omitted for now: the API defaults it to 0 and bot-side fee pricing
    // is deferred to a follow-up task. The integratorId is validated by initiateDepositV3's guard
    // before we reach here; re-assert so the required request field narrows to a string.
    const integratorId = depositMessage.integrator?.integratorId;
    assert(
      isDefined(integratorId) && INTEGRATOR_ID_REGEX.test(integratorId),
      "DepositAddressHandler: _getExecuteTx requires a validated integratorId"
    );
    const request = {
      destination: {
        token: {
          chainId: Number(routeParams.destinationChainId),
          address: routeParams.outputToken,
        },
        recipient: routeParams.recipient.address,
      },
      originChainId: Number(erc20Transfer.chainId),
      ...(this.config.enableExecuteInputToken
        ? {
            inputToken: {
              chainId: Number(erc20Transfer.chainId),
              address: erc20Transfer.contractAddress,
            },
          }
        : {}),
      userAddress: refundAddress.address,
      amount: sweepAmount,
      executionFeeRecipient: this.signerAddress.toNative(),
      integratorId,
      // Provenance reference to the inbound funding transfer. When accepted, the API folds this into a
      // Multicall3 bundle that emits a version-2 provenance blob, giving the indexer an on-chain
      // sweep ↔ funding-transfer link in the execute receipt. Gated because an API without the schema
      // change rejects the field (400 INVALID_PARAM, `Expected type 'never'`). Number() is a no-op on
      // an already-numeric chainId, so this keeps working if the indexer later types it as a number.
      ...(this.config.enableExecuteErc20Transfer
        ? {
            erc20Transfer: {
              chainId: Number(erc20Transfer.chainId),
              blockNumber: erc20Transfer.blockNumber,
              transactionHash: erc20Transfer.transactionHash,
              logIndex: erc20Transfer.logIndex,
            },
          }
        : {}),
    };
    // `_post` swallows errors and returns undefined, so retry on both throw and falsy return.
    try {
      const result = await this.api.executeDepositAddress(request);
      if (result) {
        return result;
      }
    } catch {
      // Logging is handled in AcrossSwapApiClient.
    }
    return retriesRemaining > 0 ? this._getExecuteTx(depositMessage, sweepAmount, --retriesRemaining) : undefined;
  }

  /**
   * v3 refund-withdraw path entry point. Gated behind config.enableV3Withdrawals and only reached
   * for `mis_route` classifications (see processExecution). Refunds funds stranded on a v3
   * (upgradeable-counterfactual) deposit address back to the committed refund address via the
   * quote-api v3 sign-withdraw endpoint, which bundles the BeaconProxy deploy + signedWithdrawToUser
   * into a single Multicall3 call when the proxy is not yet on-chain. Gas is deducted from the
   * refund (`deductGasFromRefund: true`) so refunds are not operated at a loss; a terminal 422
   * (fee ≥ refund / unpriceable token) is persisted and never retried.
   */
  private async initiateWithdrawV3(depositMessage: DepositAddressMessageV3): Promise<void> {
    const { depositAddress, refundAddress, erc20Transfer, depositAddressNamespace } = depositMessage;
    const { amount, transactionHash: refTxHash, contractAddress: token } = erc20Transfer;
    // Refund chain is where the funds landed.
    const chainId = Number(erc20Transfer.chainId);
    const depositKey = getDepositKey(depositMessage);

    if (!this.config.enableV3Withdrawals) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateWithdrawV3",
        message: "deposit-address transfer skipped: v3 withdraw flow disabled",
        depositAddress,
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
        at: "DepositAddressHandler#initiateWithdrawV3",
        message: "Skipping already executed withdraw (found in Redis)",
        refTxHash,
        depositKey,
      });
      return;
    }

    // Skip if a previous attempt hit a terminal 422 (persisted in Redis); never re-attempt.
    if (this.terminallySkippedWithdrawKeys.has(depositKey)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateWithdrawV3",
        message: "Skipping terminally-skipped withdraw (found in Redis)",
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
      // The withdraw user identity and deposit address must be EVM addresses for this path.
      if (depositAddressNamespace !== "evm" || refundAddress.namespace !== "evm") {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdrawV3",
          message: "Skipping v3 withdraw: unsupported account namespace",
          depositAddressNamespace,
          refundAddressNamespace: refundAddress.namespace,
          depositAddress,
          refTxHash,
          chainId,
        });
        return;
      }

      const withdrawLeaf = depositMessage.counterfactualMaterials.find((leaf) => leaf.kind === "withdraw");
      if (
        !isDefined(withdrawLeaf) ||
        !isDefined(withdrawLeaf.merkleProof) ||
        !isDefined(withdrawLeaf.implementationAddress)
      ) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdrawV3",
          message: "Skipping v3 withdraw: message missing withdraw leaf materials",
          depositAddress,
          refTxHash,
          chainId,
        });
        return;
      }

      // Defensive on-chain balance check — guards against reorged indexer messages and against
      // acting on a deposit-address already withdrawn through another path.
      const tokenContract = new Contract(token, ERC20_ABI, this.providersByChain[chainId]);
      let onchainBalance: BigNumber;
      try {
        onchainBalance = await tokenContract.balanceOf(depositAddress);
      } catch (err) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdrawV3",
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

      if (onchainBalance.lt(this.config.minSweepAmount)) {
        this.logger.debug({
          at: "DepositAddressHandler#initiateWithdrawV3",
          message: "Skipping withdraw: deposit address balance below min transfer amount",
          depositAddress,
          token,
          amount,
          onchainBalance: onchainBalance.toString(),
          depositKey,
          refTxHash,
          chainId,
          min: this.config.minSweepAmount,
        });
        return;
      }

      const sweepAmount = this._getSweepAmount(amount, onchainBalance, {
        at: "DepositAddressHandler#initiateWithdrawV3",
        depositAddress,
        token,
        depositKey,
        refTxHash,
        chainId,
      });

      const signed = await this._getSignedWithdrawV3(depositMessage, withdrawLeaf, sweepAmount);
      if (!isDefined(signed)) {
        // _getSignedWithdrawV3 already logged (transient retry-exhausted or terminal 422 skip).
        return;
      }

      if (signed.signedWithdrawTx.chainId !== chainId) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdrawV3",
          message: "Skipping withdraw: signed payload chainId does not match refund chainId",
          signedChainId: signed.signedWithdrawTx.chainId,
          chainId,
          depositKey,
          refTxHash,
          depositAddress,
        });
        return;
      }

      // The signature is deadline-bounded; leave headroom for simulation + broadcast + confirmation.
      if (signed.deadline < getCurrentTime() + V3_SIGNATURE_DEADLINE_BUFFER) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdrawV3",
          message: "Skipping withdraw: signature deadline too close to expiry",
          deadline: signed.deadline,
          depositKey,
          refTxHash,
          depositAddress,
          chainId,
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
        mrkdwn: `v3 refund withdraw on ${getNetworkName(chainId)} for deposit address ${blockExplorerLink(
          depositAddress,
          chainId
        )} (requestedAmount: ${signed.requestedAmount}, appliedGasFee: ${signed.appliedGasFee}, netAmount: ${
          signed.netAmount
        }, bundledDeploy: ${signed.bundledDeploy})`,
      };

      const receipt = await sendAndConfirmTransaction(withdrawTx, this.transactionClient, useDispatcher);
      if (!isDefined(receipt)) {
        this.logger.warn({
          at: "DepositAddressHandler#initiateWithdrawV3",
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
      await this._publishWithdrawExecuted(receipt, depositMessage);
    } finally {
      if (!withdrawCommitted) {
        this.observedExecutedWithdraws[chainId].delete(depositKey);
      }
    }
  }

  /**
   * Fetches v3 signed-withdraw calldata from the quote-api. Classifies failures: a terminal 422
   * (`GAS_EXCEEDS_REFUND` / `UNPRICEABLE_REFUND_TOKEN`) is persisted to the terminal-skip set and
   * never retried; every other failure (network, timeout, 5xx, transient 400) is retried.
   */
  private async _getSignedWithdrawV3(
    depositMessage: DepositAddressMessageV3,
    withdrawLeaf: CounterfactualMaterialV3,
    sweepAmount: string,
    retriesRemaining = 3
  ): Promise<DepositAddressSignWithdrawResponse | undefined> {
    const { depositAddress, refundAddress, erc20Transfer, initialRoot, salt } = depositMessage;
    const { contractAddress: token, chainId } = erc20Transfer;
    const depositKey = getDepositKey(depositMessage);
    const request = {
      chainId: Number(chainId),
      depositAddress,
      initialRoot,
      salt,
      token,
      amount: sweepAmount,
      user: refundAddress.address,
      proof: withdrawLeaf.merkleProof,
      counterfactualDepositFactory: depositMessage.counterfactualFactoryContractAddress,
      counterfactualBeacon: depositMessage.counterfactualBeaconContractAddress,
      adminWithdrawManager: depositMessage.adminWithdrawManagerContractAddress,
      withdrawImplementation: withdrawLeaf.implementationAddress,
      deductGasFromRefund: true,
    };
    try {
      return await this.api.signWithdrawDepositAddressV3(request);
    } catch (err) {
      // 422 is a terminal state per product decision: gas exceeds the refund or the refund token is
      // unpriceable. Persist the skip so it survives handover and is not re-attempted on later polls.
      if (isHttpError(err) && err.status === 422) {
        this.terminallySkippedWithdrawKeys.add(depositKey);
        await this._persistSkippedWithdrawKeysRedis();
        this.logger.warn({
          at: "DepositAddressHandler#_getSignedWithdrawV3",
          message: "Skipping withdraw permanently: quote-api returned terminal 422",
          status: err.status,
          error: err.message,
          depositKey,
          depositAddress,
          chainId: Number(chainId),
        });
        return undefined;
      }
      // Logging is handled in AcrossSwapApiClient/base client; retry transient failures.
      return retriesRemaining > 0
        ? this._getSignedWithdrawV3(depositMessage, withdrawLeaf, sweepAmount, --retriesRemaining)
        : undefined;
    }
  }

  /**
   * Amount forwarded to the quote-api: the max of the indexer-reported transfer amount and the
   * deposit address's current on-chain balance. The balance can exceed the reported transfer
   * (e.g. multiple funding transfers to the same address, or dust sent outside the indexed
   * transfer); sweeping only the reported amount would strand the excess on the deposit address.
   * Callers have already skipped when the balance is below the reported amount, so in practice
   * this resolves to the on-chain balance.
   */
  private _getSweepAmount(
    indexerAmount: string,
    onchainBalance: BigNumber,
    logContext: Record<string, unknown>
  ): string {
    if (onchainBalance.lte(toBN(indexerAmount))) {
      return indexerAmount;
    }
    this.logger.debug({
      message: "Sweeping full on-chain balance above indexer-reported transfer amount",
      indexerAmount,
      onchainBalance: onchainBalance.toString(),
      ...logContext,
    });
    return onchainBalance.toString();
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
  private async _queryIndexerApi(retriesRemaining = 3): Promise<AnyDepositAddressMessage[]> {
    let apiResponseData: AnyDepositAddressMessage[] | undefined = undefined;
    try {
      apiResponseData = await this.indexerApi.get<AnyDepositAddressMessage[]>(this.config.indexerApiEndpoint, {});
    } catch {
      // Error log should have been emitted in IndexerApiClient.
    }
    if (!isDefined(apiResponseData)) {
      return retriesRemaining > 0 ? this._queryIndexerApi(--retriesRemaining) : [];
    }
    // Drop unsupported message versions BEFORE normalization. Unsupported payloads (e.g. v2) may
    // not carry the v1 shape (routeParams/erc20Transfer/counterfactualMaterials), and
    // normalizeDepositAddressMessage dereferences those unconditionally — a single bad message
    // would throw and sink the whole batch, starving supported messages in the same response.
    // Only top-level fields are safe to read here. v3 items keep their own shape and are passed
    // through un-normalized (the v3 execute path is EVM-only and guards namespaces itself).
    return apiResponseData
      .filter((message) => {
        const { version } = message;
        if (isDefined(version) && !SUPPORTED_INDEXER_MESSAGE_VERSIONS.has(version)) {
          this.logger.debug({
            at: "DepositAddressHandler#_queryIndexerApi",
            message: "deposit-address transfer skipped: unsupported message version",
            version,
            depositAddress: message.depositAddress,
          });
          return false;
        }
        return true;
      })
      .map((message) => (isDepositAddressMessageV3(message) ? message : normalizeDepositAddressMessage(message)));
  }

  private async _getSwapApiQuote(
    depositMessage: DepositAddressMessage,
    sweepAmount: string,
    retriesRemaining = 3
  ): Promise<SwapApiResponse | undefined> {
    const { depositAddress, routeParams, counterfactualMaterials } = depositMessage;
    const { inputToken, outputToken, originChainId, destinationChainId, recipient, refundAddress } = routeParams;
    const originChainIdNum = Number(originChainId);
    const destinationChainIdNum = Number(destinationChainId);
    // Worst-case executionFee committed per leaf into the immutable merkle root at deposit-address
    // creation. Echo the exact committed value back (verbatim, never re-priced) so the swap-api
    // rebuilds the same leaf/root; omit when absent so legacy (pre-fee) addresses request as before.
    // Only the route-relevant leaf is nonzero; the swap-api selects which one applies by strategy.
    const cctpExecutionFee = counterfactualMaterials?.cctpLeaf?.params?.executionFee;
    const spokePoolExecutionFee = counterfactualMaterials?.spokePoolLeaf?.params?.executionFee;
    // Integrator attribution from the indexer message, forwarded verbatim for tagging. `?? undefined`
    // collapses both a missing `integrator` and an explicit null id, so absent integrators contribute
    // no query param (stripped at serialization) and the request keeps its legacy shape.
    const integratorId = depositMessage.integrator?.integratorId ?? undefined;
    // Swap API expects Tron origin fields in base58; on-chain paths keep ethers `0x` via normalizeDepositAddressMessage.
    // refundAddress must match what was committed in the withdraw leaf at PDA creation time so the
    // swap-api rebuilds the same merkle root the on-chain factory derives the deposit address from.
    const params = {
      originChainId,
      destinationChainId,
      inputToken: toAddressType(inputToken, originChainIdNum).toNative(),
      outputToken: toAddressType(outputToken, destinationChainIdNum).toNative(),
      tradeType: "exactInput", // Should be exactInput for counterfactual deposits.
      amount: sweepAmount,
      depositor: toAddressType(depositAddress, originChainIdNum).toNative(),
      recipient: toAddressType(recipient, destinationChainIdNum).toNative(),
      refundAddress: toAddressType(refundAddress, originChainIdNum).toNative(),
      depositAddress: toAddressType(depositAddress, originChainIdNum).toNative(),
      executionFeeRecipient: toAddressType(this.signerAddress.toNative(), originChainIdNum).toNative(),
      shouldSponsorAccountCreation: String(depositMessage.shouldSponsorAccountCreation),
      cctpExecutionFee,
      spokePoolExecutionFee,
      integratorId,
    };
    try {
      return await this.api.getCounterfactualDepositQuote(params);
    } catch {
      // Logging should have been done in the swap api client, so we do not need to log here.
      return retriesRemaining > 0 ? this._getSwapApiQuote(depositMessage, sweepAmount, --retriesRemaining) : undefined;
    }
  }
}
