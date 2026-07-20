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
  delay,
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
  isNativeTokenSentinel,
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
  AugmentedTransaction,
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
 * Max seconds the outgoing instance waits, after observing a handover, for in-flight poll ticks
 * to settle (tx confirmation + Redis persist of the executed marker) before signalling drained.
 * An execution abandoned between broadcast and persist is exactly how a successor comes to
 * replay a sweep (2026-07-20 duplicate-sweep incident), so this errs long; the pending-execution
 * marker still covers anything that outlives the drain.
 */
const HANDOVER_DRAIN_TIMEOUT = 90;

/**
 * Max seconds the incoming instance waits for its predecessor's drained signal before loading
 * persisted state and starting to poll. Must exceed HANDOVER_DRAIN_TIMEOUT plus the
 * predecessor's ~1s handover-detection latency so a live predecessor always beats the timeout;
 * the timeout only bites when the predecessor crashed (or predates this protocol).
 */
const HANDOVER_TAKEOVER_TIMEOUT = 120;

/**
 * TTL (seconds) on a pending-execution marker, written to Redis immediately before every
 * fund-moving broadcast and cleared once the confirmed execution is persisted. A marker written
 * by another instance defers this instance's execution of that transfer, so the TTL bounds how
 * long a transfer stays deferred when its broadcast outcome is unknown (instance crashed
 * mid-flight, or confirmation failed after a possible broadcast). Sized to comfortably outlive
 * any broadcast→confirmation window; a deferred sweep is recoverable, a double-spend is not.
 */
const PENDING_EXECUTION_EXPIRY = 900;

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class DepositAddressHandler {
  private abortController = new AbortController();
  private _instanceCoordinator?: InstanceCoordinator;
  private initialized = false;
  private consecutiveHeartbeatFailures = 0;

  /**
   * True once a handover/shutdown has been observed — including during initialize(), which cedes
   * without loading state when the abort fires (or a newer instance takes the lease) while it is
   * blocked on the predecessor drain. The caller must not start polling in that case.
   */
  public get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

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

  /**
   * Poll ticks currently in flight. On handover the outgoing instance must not exit while one of
   * these may still be between broadcast and Redis persist — see drainInFlightWork().
   */
  private inFlightTicks: Set<Promise<unknown>> = new Set();

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

    // Establish bot instance and take over. Wait for the predecessor to finish draining its
    // in-flight executions (it persists their executed markers as part of the drain) BEFORE
    // loading the persisted sets — loading earlier races the predecessor's final persist and is
    // how a swept transfer gets replayed (2026-07-20 duplicate-sweep incident).
    this.instanceCoordinator = new InstanceCoordinator(
      this.logger,
      this.redisCache,
      this.config.botIdentifier,
      this.config.runIdentifier,
      this.abortController
    );
    const predecessor = await this.instanceCoordinator.initiateHandover();
    // Heartbeat while blocked on the predecessor: it stops its own watchdog the moment it
    // observes this takeover, and this wait can exceed the ~60s Checkly alert window — a healthy
    // handover must not page as a dead bot.
    const drainWaitHeartbeat = new AbortController();
    scheduleTask(() => this.kickWatchdog(), this.config.watchdogInterval, drainWaitHeartbeat.signal);
    let predecessorDrained: boolean;
    try {
      predecessorDrained = await this.instanceCoordinator.waitForPredecessorDrain(
        predecessor,
        HANDOVER_TAKEOVER_TIMEOUT
      );
    } finally {
      drainWaitHeartbeat.abort();
    }
    // waitForPredecessorDrain also returns false when this handler's own abort signal fires
    // (SIGHUP/disconnect during the wait). That is a shutdown, not a takeover timeout: cede
    // without loading state — the caller checks `aborted` and must not start polling.
    if (this.abortController.signal.aborted) {
      this.logger.debug({
        at: "DepositAddressHandler#initialize",
        message: "Shutdown observed while waiting for predecessor drain; ceding without starting.",
        predecessor,
      });
      return;
    }
    if (!predecessorDrained) {
      this.logger.warn({
        at: "DepositAddressHandler#initialize",
        message:
          "Predecessor instance did not signal drained; proceeding. Pending-execution markers still defer any broadcast it left in flight.",
        predecessor,
        timeoutSeconds: HANDOVER_TAKEOVER_TIMEOUT,
      });
    }
    // A newer instance may have taken the lease while this one was blocked here; polling would
    // then run executions from a stale instance until waitForDisconnect's next 1s subscribe poll
    // notices the newer lease. Cede immediately instead.
    if (!(await this.instanceCoordinator.isActiveInstance())) {
      this.logger.warn({
        at: "DepositAddressHandler#initialize",
        message: "Another instance took over while waiting for predecessor drain; ceding without starting.",
        predecessor,
      });
      this.abortController.abort();
      return;
    }

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
      () => this.trackTick(this.evaluateDepositAddresses()),
      this.config.indexerPollingInterval,
      this.abortController.signal,
      // A rejected poll skips the whole batch for that tick; without this log the failure is
      // invisible (scheduleTask otherwise swallows rejections) while fills silently stall.
      (err) =>
        this.logger.error({
          at: "DepositAddressHandler#pollAndExecute",
          message: "evaluateDepositAddresses failed; batch skipped this tick",
          error: err instanceof Error ? err.message : String(err),
        })
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
   * Calls the abort controller once a handoff is observed, then drains in-flight executions
   * (so a broadcast tx gets confirmed and its executed marker persisted rather than orphaned)
   * and signals the successor that it is safe to load state and start polling.
   */
  public async waitForDisconnect(): Promise<void> {
    await this.instanceCoordinator.subscribe();
    this.abortController.abort();
    await this.drainInFlightWork(HANDOVER_DRAIN_TIMEOUT);
    try {
      await this.instanceCoordinator.signalDrained();
    } catch (err) {
      // The successor times out and proceeds; pending-execution markers still guard replays.
      this.logger.error({
        at: "DepositAddressHandler#waitForDisconnect",
        message: "Failed to signal drained to successor",
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Registers a poll tick for handover draining. Returns a chained promise so scheduleTask's
   * rejection handling still applies; the raw tick is what drainInFlightWork awaits. */
  private trackTick(tick: Promise<unknown>): Promise<unknown> {
    this.inFlightTicks.add(tick);
    return tick.finally(() => this.inFlightTicks.delete(tick));
  }

  /**
   * Waits (bounded) for in-flight poll ticks to settle after the abort signal fired. A tick that
   * has broadcast a tx persists its executed marker and clears its pending marker as it settles;
   * exiting before that is what turns a handover into a replayed execution.
   */
  private async drainInFlightWork(timeoutSeconds: number): Promise<void> {
    if (this.inFlightTicks.size === 0) {
      return;
    }
    this.logger.debug({
      at: "DepositAddressHandler#drainInFlightWork",
      message: "Draining in-flight poll ticks before ceding",
      inFlightTicks: this.inFlightTicks.size,
    });
    let timedOut = false;
    await Promise.race([
      Promise.allSettled([...this.inFlightTicks]),
      delay(timeoutSeconds).then(() => (timedOut = true)),
    ]);
    if (timedOut) {
      this.logger.warn({
        at: "DepositAddressHandler#drainInFlightWork",
        message:
          "In-flight work did not settle within the drain timeout; ceding anyway. Pending-execution markers defer the successor from any broadcast still in flight.",
        inFlightTicks: this.inFlightTicks.size,
        timeoutSeconds,
      });
    } else {
      this.logger.debug({
        at: "DepositAddressHandler#drainInFlightWork",
        message: "Drained all in-flight poll ticks",
      });
    }
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
      // Once a handover/shutdown is observed, initiate no new executions — in-flight ones are
      // drained by waitForDisconnect; anything not yet started belongs to the successor.
      if (this.abortController.signal.aborted) {
        return;
      }
      await this.processExecution(depositMessage);
    });
  }

  private getPendingExecutionRedisKey(depositKey: string): string {
    return `deposit-address:pending-execution:${this.config.botIdentifier}:${depositKey}`;
  }

  /**
   * Returns true when another instance has recorded a pending (possibly still in-flight)
   * fund-moving broadcast for this depositKey. Markers written by this instance don't defer it:
   * its in-memory in-flight sets are strictly better informed, and blocking on our own marker
   * would stall the normal retry path after a failed submit.
   *
   * Advisory pre-filter only — it saves the API/chain reads that follow, but a concurrent
   * instance can write its marker after this read. The authoritative guard is the atomic
   * acquisition in preBroadcastCheckpoint.
   */
  private async hasForeignPendingExecution(depositKey: string): Promise<boolean> {
    assert(isDefined(this.redisCache), "DepositAddressHandler: redisCache accessed before initialize()");
    const owner = await this.redisCache.get<string>(this.getPendingExecutionRedisKey(depositKey));
    return isDefined(owner) && owner !== this.config.runIdentifier;
  }

  /**
   * Atomically acquires the pending-execution marker; returns false when another instance owns
   * it, in which case the caller must NOT broadcast. MUST be awaited immediately before every
   * fund-moving broadcast: if this instance dies between broadcast and persisting the executed
   * marker, the marker is the only thing standing between the successor and a replayed execution,
   * and two live instances racing the same transfer (overlapping replacement starts, or a
   * takeover timeout while the old process still runs) must not both proceed past it.
   *
   * SET NX first; on conflict, re-take the marker only if it is already this instance's own — a
   * failed submit intentionally leaves the marker in place (see clearPendingExecution), so the
   * same-instance retry path must be able to re-acquire it.
   */
  private async acquirePendingExecution(depositKey: string): Promise<boolean> {
    assert(isDefined(this.redisCache), "DepositAddressHandler: redisCache accessed before initialize()");
    const redisKey = this.getPendingExecutionRedisKey(depositKey);
    const ttlMs = PENDING_EXECUTION_EXPIRY * 1000;
    return (
      (await this.redisCache.acquireLock(redisKey, this.config.runIdentifier, ttlMs)) ||
      (await this.redisCache.renewLock(redisKey, this.config.runIdentifier, ttlMs))
    );
  }

  /**
   * Releases the pending-execution marker after the confirmed execution has been persisted to the
   * executed set. Ownership-checked (compare-and-delete): if this instance's marker expired
   * mid-flight and another instance has since acquired the key, that marker is left intact.
   * Best-effort: on failure the marker expires via its TTL. Never call this after a failed
   * submit — a "failed" sendAndConfirm may still have broadcast (confirmation failure), so the
   * marker must outlive it.
   */
  private async clearPendingExecution(depositKey: string): Promise<void> {
    assert(isDefined(this.redisCache), "DepositAddressHandler: redisCache accessed before initialize()");
    try {
      await this.redisCache.releaseLock(this.getPendingExecutionRedisKey(depositKey), this.config.runIdentifier);
    } catch (err) {
      this.logger.warn({
        at: "DepositAddressHandler#clearPendingExecution",
        message: "Failed to clear pending-execution marker; it will expire via TTL",
        depositKey,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Guards a fund-moving broadcast: bails when a handover was observed mid-message (the
   * successor re-evaluates from scratch — a broadcast from a ceding instance is how replays
   * happen), then atomically acquires the pending-execution marker. Returns false when the
   * caller must NOT broadcast.
   */
  private async preBroadcastCheckpoint(depositKey: string, at: string): Promise<boolean> {
    if (this.abortController.signal.aborted) {
      this.logger.debug({
        at,
        message: "Skipping broadcast: handover/shutdown observed, leaving execution to the successor",
        depositKey,
      });
      return false;
    }
    try {
      // Atomic: two live instances can both pass the earlier hasForeignPendingExecution read for
      // the same transfer; only the one that wins the marker may broadcast.
      if (!(await this.acquirePendingExecution(depositKey))) {
        this.logger.debug({
          at,
          message: "Skipping broadcast: pending-execution marker acquired by another instance",
          depositKey,
        });
        return false;
      }
    } catch (err) {
      this.logger.warn({
        at,
        message: "Skipping broadcast: failed to persist pending-execution marker",
        depositKey,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    return true;
  }

  /** Thin wrapper over sendAndConfirmTransaction so unit tests can stub the broadcast. */
  protected sendAndConfirm(tx: AugmentedTransaction, useDispatcher: boolean): Promise<TransactionReceipt | undefined> {
    return sendAndConfirmTransaction(tx, this.transactionClient, useDispatcher);
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

    // Native-token (sentinel) withdraws are only supported on the v3 scheme — the v1 withdraw
    // contract path cannot move native funds, so calling the sign-withdraw API would only fail.
    if (isNativeTokenSentinel(token)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateWithdraw",
        message: "Skipping withdraw: native-token withdraws are not supported on v1 deposit addresses",
        depositAddress,
        token,
        depositKey,
        refTxHash,
        chainId,
      });
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

    // Defer while another instance may have a broadcast in flight for this transfer (it crashed
    // or is still draining); the marker expires via TTL if that instance never resolves it.
    if (await this.hasForeignPendingExecution(depositKey)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateWithdraw",
        message: "Skipping withdraw: pending-execution marker held by another instance",
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
      let onchainBalance: BigNumber;
      try {
        onchainBalance = await this.getDepositAddressBalance(chainId, token, depositAddress);
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

      if (!(await this.preBroadcastCheckpoint(depositKey, "DepositAddressHandler#initiateWithdraw"))) {
        return;
      }
      const receipt = await this.sendAndConfirm(withdrawTx, useDispatcher);
      if (!isDefined(receipt)) {
        // Pending marker intentionally left: the tx may still have broadcast (confirmation
        // failure), so let the TTL expire it rather than invite a cross-instance replay.
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
      await this.clearPendingExecution(depositKey);
      await this._publishWithdrawExecuted(receipt, depositMessage);
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
        message:
          "Skipping publish: no settlement log (ERC20 Transfer / native Withdraw, deposit address → refund address) found in receipt",
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

    // Defer while another instance may have a broadcast in flight for this transfer (it crashed
    // or is still draining); the marker expires via TTL if that instance never resolves it.
    if (await this.hasForeignPendingExecution(depositKey)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateDeposit",
        message: "Skipping deposit: pending-execution marker held by another instance",
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
    const balanceOfContract = await this.getDepositAddressBalance(
      originChainId,
      inputToken,
      depositMessage.depositAddress
    );
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

      // No pending-execution marker for the deploy: it moves no funds and a replay is guarded
      // by the isContractDeployed check (at worst a reverted no-op).
      const deployReceipt = await this.sendAndConfirm(deployTx, useDispatcher);
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

    if (!(await this.preBroadcastCheckpoint(depositKey, "DepositAddressHandler#initiateDeposit"))) {
      this.observedExecutedDeposits[originChainId].delete(depositKey);
      return;
    }
    const depositReceipt = await this.sendAndConfirm(executeTx, useDispatcher);

    if (!depositReceipt) {
      // Pending marker intentionally left: the tx may still have broadcast (confirmation
      // failure), so let the TTL expire it rather than invite a cross-instance replay.
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
    await this.clearPendingExecution(depositKey);
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

    // Defer while another instance may have a broadcast in flight for this transfer (it crashed
    // or is still draining); the marker expires via TTL if that instance never resolves it.
    if (await this.hasForeignPendingExecution(depositKey)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateDepositV3",
        message: "Skipping deposit: pending-execution marker held by another instance",
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
      const onchainBalance: BigNumber = await this.getDepositAddressBalance(originChainId, inputToken, depositAddress);
      if (onchainBalance.lt(toBN(amount))) {
        this.logger.debug({
          at: "DepositAddressHandler#initiateDepositV3",
          message: "Deposit address does not have sufficient input token balance to initiate deposit.",
          depositKey,
          depositAddress,
          inputToken,
          amount,
          onchainBalance: onchainBalance.toString(),
        });
        return;
      }

      const executeResponse = await this._getExecuteTx(depositMessage);
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

      if (!(await this.preBroadcastCheckpoint(depositKey, "DepositAddressHandler#initiateDepositV3"))) {
        return;
      }
      const depositReceipt = await this.sendAndConfirm(executeTx, useDispatcher);
      if (!isDefined(depositReceipt)) {
        // Pending marker intentionally left: the tx may still have broadcast (confirmation
        // failure), so let the TTL expire it rather than invite a cross-instance replay.
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
      await this.clearPendingExecution(depositKey);
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
      amount: erc20Transfer.amount,
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
    return retriesRemaining > 0 ? this._getExecuteTx(depositMessage, --retriesRemaining) : undefined;
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

    // Defer while another instance may have a broadcast in flight for this transfer (it crashed
    // or is still draining); the marker expires via TTL if that instance never resolves it.
    if (await this.hasForeignPendingExecution(depositKey)) {
      this.logger.debug({
        at: "DepositAddressHandler#initiateWithdrawV3",
        message: "Skipping withdraw: pending-execution marker held by another instance",
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
      let onchainBalance: BigNumber;
      try {
        onchainBalance = await this.getDepositAddressBalance(chainId, token, depositAddress);
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

      if (onchainBalance.lt(toBN(amount))) {
        this.logger.debug({
          at: "DepositAddressHandler#initiateWithdrawV3",
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

      const signed = await this._getSignedWithdrawV3(depositMessage, withdrawLeaf);
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

      if (!(await this.preBroadcastCheckpoint(depositKey, "DepositAddressHandler#initiateWithdrawV3"))) {
        return;
      }
      const receipt = await this.sendAndConfirm(withdrawTx, useDispatcher);
      if (!isDefined(receipt)) {
        // Pending marker intentionally left: the tx may still have broadcast (confirmation
        // failure), so let the TTL expire it rather than invite a cross-instance replay.
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
      await this.clearPendingExecution(depositKey);
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
    retriesRemaining = 3
  ): Promise<DepositAddressSignWithdrawResponse | undefined> {
    const { depositAddress, refundAddress, erc20Transfer, initialRoot, salt } = depositMessage;
    const { contractAddress: token, amount, chainId } = erc20Transfer;
    const depositKey = getDepositKey(depositMessage);
    const request = {
      chainId: Number(chainId),
      depositAddress,
      initialRoot,
      salt,
      token,
      amount,
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
        ? this._getSignedWithdrawV3(depositMessage, withdrawLeaf, --retriesRemaining)
        : undefined;
    }
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

  /**
   * @notice Returns the deposit address's balance of `token` on `chainId`. Native transfers are
   * indexed with the sentinel token address, which has no contract — read those via
   * `provider.getBalance` instead of `balanceOf` (which reverts on the sentinel).
   */
  private async getDepositAddressBalance(chainId: number, token: string, depositAddress: string): Promise<BigNumber> {
    const provider = this.providersByChain[chainId];
    assert(isDefined(provider), `Provider not found for chain ${chainId}`);
    if (isNativeTokenSentinel(token)) {
      return provider.getBalance(depositAddress);
    }
    return new Contract(token, ERC20_ABI, provider).balanceOf(depositAddress);
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
      .flatMap((message): AnyDepositAddressMessage[] => {
        if (isDepositAddressMessageV3(message)) {
          return [message];
        }
        // The version allowlist only proves the version is supported, not that the payload is
        // well-formed. Normalization throwing on one malformed message must drop that message,
        // not the batch — a redelivered poison message would otherwise starve every supported
        // message for the indexer's whole redelivery window (2026-07-15 incident).
        try {
          return [normalizeDepositAddressMessage(message)];
        } catch (err) {
          this.logger.warn({
            at: "DepositAddressHandler#_queryIndexerApi",
            message: "deposit-address transfer dropped: message failed normalization",
            version: message.version,
            depositAddress: message.depositAddress,
            txHash: message.erc20Transfer?.transactionHash,
            chainId: message.erc20Transfer?.chainId,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      });
  }

  private async _getSwapApiQuote(
    depositMessage: DepositAddressMessage,
    retriesRemaining = 3
  ): Promise<SwapApiResponse | undefined> {
    const { depositAddress, routeParams, erc20Transfer, counterfactualMaterials } = depositMessage;
    const { inputToken, outputToken, originChainId, destinationChainId, recipient, refundAddress } = routeParams;
    const { amount } = erc20Transfer;
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
      amount,
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
      return retriesRemaining > 0 ? this._getSwapApiQuote(depositMessage, --retriesRemaining) : undefined;
    }
  }
}
