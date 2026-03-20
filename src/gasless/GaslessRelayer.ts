import winston from "winston";
import { GaslessRelayerConfig } from "./GaslessRelayerConfig";
import {
  Address,
  isDefined,
  getRedisCache,
  delay,
  Signer,
  scheduleTask,
  forEachAsync,
  Provider,
  getCurrentTime,
  getSpokePool,
  getProvider,
  paginatedEventQuery,
  getBlockForTimestamp,
  EventSearchConfig,
  Contract,
  spreadEventWithBlockNumber,
  unpackFillEvent,
  unpackDepositEvent,
  mapAsync,
  TransactionReceipt,
  EvmAddress,
  toBN,
  blockExplorerLink,
  getNetworkName,
  relayFillStatus,
  sendAndConfirmTransaction,
  getTokenInfo,
  createFormatFunction,
  toAddressType,
  getSpokePoolPeriphery,
  compareAddressesSimple,
  ConvertDecimals,
  assert,
  InstanceCoordinator,
  MAX_UINT_VAL,
  toBNWei,
  willSucceed,
  TOKEN_SYMBOLS_MAP,
} from "../utils";
import {
  APIGaslessDepositResponse,
  DepositWithBlock,
  FillStatus,
  FillWithBlock,
  GaslessDepositMessage,
  RelayData,
} from "../interfaces";
import { AcrossSwapApiClient, TransactionClient } from "../clients";
import EIP3009_ABI from "../common/abi/EIP3009.json";
import {
  buildGaslessDepositTx,
  buildGaslessFillRelayTx,
  buildSyntheticDeposit,
  getGaslessAuthorizerAddress,
  getGaslessPermitNonce,
  isAllowedGaslessPair,
  isExclusivityRelative,
  isStablecoin,
  restructureGaslessDeposits,
  validateDeposit,
} from "../utils/GaslessUtils";

type GaslessRelayerUpdate = {
  observedFundsDeposited: {
    [chainId: number]: Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber">[];
  };
  observedFilledRelay: { [chainId: number]: FillWithBlock[] };
};
const DEPOSIT_EVENT = "FundsDeposited";

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export enum MessageState {
  INITIAL = 0,
  DEPOSIT_SUBMIT,
  DEPOSIT_CONFIRM,
  FILL_PENDING,
  FILLED,
  ERROR,
}

const MESSAGE_STATES = {
  [MessageState.INITIAL]: "INITIAL",
  [MessageState.DEPOSIT_SUBMIT]: "DEPOSIT_SUBMIT",
  [MessageState.DEPOSIT_CONFIRM]: "DEPOSIT_CONFIRM",
  [MessageState.FILL_PENDING]: "FILL_PENDING",
  [MessageState.FILLED]: "FILLED",
  [MessageState.ERROR]: "ERROR",
};

const stateToStr = (state: MessageState) => MESSAGE_STATES[state] ?? "UNKNOWN";

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class GaslessRelayer {
  private abortController = new AbortController();
  private instanceCoordinator;
  private initialized = false;

  protected messageState: { [key: string]: MessageState } = {};
  protected providersByChain: { [chainId: number]: Provider } = {};
  // The object is indexed by `chainId`. An `AuthorizationUsed` event is marked by adding `${token}:${authorizer}:${nonce}` to the respective chain's set.
  protected observedDeposits: { [chainId: number]: Set<string> } = {};
  // The object is indexed by `chainId`. A `FilledRelay` event is marked by adding `${originChainId}:${depositId}` to the respective chain's set.
  protected observedFills: { [chainId: number]: Set<string> } = {};
  // The object is indexed by `chainId`. Each element of the set is a deposit which should be retried in the bot's runtime.
  private retryableFills: {
    [chainId: number]: {
      [depositKey: string]: Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber">;
    };
  } = {};
  // The object is indexed by `chainId`. A SpokePoolPeriphery contract is indexed by the chain ID.
  protected spokePoolPeripheries: { [chainId: number]: Contract } = {};
  // The object is indexed by `chainId`. A SpokePool contract is indexed by the chain ID.
  protected spokePools: { [chainId: number]: Contract } = {};

  private api: AcrossSwapApiClient;
  protected signerAddress: EvmAddress;

  private transactionClient;
  private redisCache;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: GaslessRelayerConfig,
    readonly baseSigner: Signer,
    readonly depositSigners: Signer[]
  ) {
    this.api = new AcrossSwapApiClient(this.logger, this.config.apiTimeoutOverride);
    this.transactionClient = new TransactionClient(this.logger, depositSigners);
    config.relayerDestinationChains.forEach((chainId) => (this.retryableFills[chainId] = {}));
  }

  /*
   * @notice Initializes a GaslessRelayer instance.
   */
  public async initialize(): Promise<void> {
    this.logger.debug({
      at: "GaslessRelayer#initialize",
      message: "Initializing GaslessRelayer",
    });

    const { RUN_IDENTIFIER: runIdentifier, BOT_IDENTIFIER: botIdentifier } = process.env;

    // Set the signer address.
    this.signerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.redisCache = await getRedisCache(this.logger);

    // Initialize the map with newly allocated sets.
    await forEachAsync(this.config.relayerOriginChains, async (chainId) => {
      const provider = await getProvider(chainId);
      this.providersByChain[chainId] = provider;
      this.observedDeposits[chainId] = new Set<string>();
      this.spokePoolPeripheries[chainId] = getSpokePoolPeriphery(
        chainId,
        this.config.spokePoolPeripheryOverrides[chainId]
      ).connect(provider);
    });
    await forEachAsync(this.config.relayerDestinationChains, async (chainId) => {
      this.providersByChain[chainId] ??= await getProvider(chainId);
      this.observedFills[chainId] = new Set<string>();
      this.spokePools[chainId] = getSpokePool(chainId).connect(this.baseSigner.connect(this.providersByChain[chainId]));
    });

    // Exit if OS instructs us to do so.
    process.on("SIGHUP", () => {
      this.logger.debug({
        at: "GaslessRelayer#initialize",
        message: "Received SIGHUP on gasless relayer. stopping...",
      });
      this.abortController.abort();
    });

    process.on("disconnect", () => {
      this.logger.debug({
        at: "GaslessRelayer#initialize",
        message: "Gasless relayer disconnected, stopping...",
      });
      this.abortController.abort();
    });

    // For the first runthrough, we want to specifically check the API for nonces which have corresponding deposits but no corresponding fills, and then
    // submit fills for those deposits. This is because this scenario may happen as an edge case when a prior relayer process is killed in the middle of
    // a deposit/fill flow.
    this.logger.debug({
      at: "GaslessRelayer#initialize",
      message: "Querying gasless API for initial messages",
    });
    const initialMessages = await this._queryGaslessApi(this.config.initializationRetryAttempts);

    // Update our observed signatures/fills up until `this.depositLookback`.
    // Include the list of initial deposit messages so we can map FundsDeposited events back to EIP-3009 deposit nonces.
    const observedEvents = await this.updateObserved(initialMessages);
    await this.updateObservedCctpDeposits(initialMessages);

    const unfilledDeposits = initialMessages.filter((depositMessage) => {
      const { originChainId, depositId, spokePool } = depositMessage;
      const { destinationChainId, inputToken } = depositMessage.baseDepositData;

      const depositKey = this._getDepositKey(inputToken, originChainId, depositId);
      const fillKey = this._getFilledRelayKey({ originChainId, depositId: toBN(depositId) });
      return (
        this.observedDeposits[originChainId]?.has(depositKey) &&
        isDefined(this.observedFills[destinationChainId]) &&
        !this.observedFills[destinationChainId].has(fillKey) &&
        !this._isCctpDeposit(originChainId, spokePool)
      );
    });

    this.logger.debug({
      at: "GaslessRelayer#initialize",
      message: "Found unfilled deposits",
      unfilledDeposits: unfilledDeposits.length,
    });

    await mapAsync(unfilledDeposits, async (depositMessage) => {
      const { originChainId, depositId, spokePool } = depositMessage;

      // In theory, unfilledDeposits will not have CCTP deposits, but just in case.
      if (this._isCctpDeposit(originChainId, spokePool)) {
        this.logger.debug({
          at: "GaslessRelayer#initialize",
          message: "Skipping fill for CCTP deposit (relayer does not fill CCTP).",
          depositId,
          originChainId,
        });
        return;
      }

      const correspondingDeposit = observedEvents.observedFundsDeposited[originChainId].find(
        (fundsDeposited) => fundsDeposited.depositId.toString() === depositId
      );
      assert(
        isDefined(correspondingDeposit),
        "Inconsistent data between this.observedDeposits and return data from gaslessRelayer.updateObserved()"
      );
      await this.initiateFill(correspondingDeposit, spokePool);
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
   * @notice Polls the Across gasless API and starts background deposit/fill tasks.
   */
  public pollAndExecute(): void {
    scheduleTask(() => this.evaluateApiSignatures(), this.config.apiPollingInterval, this.abortController.signal);
  }

  /*
   * @notice Starts a promise which expires when the InstanceCoordinator's lifetime ends, or when a handover signal
   * is observed.
   */
  public async waitForDisconnect(): Promise<void> {
    // Wait for the instance coordinator to receive a handover signal. Once one is received (or we expire), abort.
    await this.instanceCoordinator.subscribe();
    this.abortController.abort();
  }

  /*
   * @notice Performs an initial lookback to determine which signatures have been observed/processed onchain.
   */
  // Update our observed signatures/fills up until `this.depositLookback`.
  private async updateObserved(apiMessages: GaslessDepositMessage[]): Promise<GaslessRelayerUpdate> {
    // If a signature is spent, then the deposit must also have been initiated since the `receiveWithAuthorization` signature
    // can only be redeemed by the periphery contract.
    const [observedFundsDeposited, observedFilledRelay] = await Promise.all([
      // For each origin chain, find all the funds deposited events in lookback and check if they have an associated match with an API message. If they do, then we consider the
      // deposit "observed" and the API message in the middle of the gasless flow.
      Object.fromEntries(
        await mapAsync(this.config.relayerOriginChains, async (originChainId) => {
          const provider = this.providersByChain[originChainId];
          const observedDeposits = this.observedDeposits[originChainId];

          const searchConfig = await this._getEventSearchConfig(originChainId);

          const originSpokePool = getSpokePool(originChainId).connect(provider);
          const originFundsDepositedEvents = await paginatedEventQuery(
            originSpokePool,
            originSpokePool.filters.FundsDeposited(),
            searchConfig
          );
          const originEventsWithApiMessages = originFundsDepositedEvents
            .map((event) => {
              const deposit = unpackDepositEvent(spreadEventWithBlockNumber(event), originChainId);
              const apiMessage = apiMessages.find(({ depositId }) => deposit.depositId.toString() === depositId);
              if (isDefined(apiMessage)) {
                return { apiMessage, deposit };
              }
              return undefined;
            })
            .filter(isDefined);
          originEventsWithApiMessages.forEach(({ deposit }) => {
            observedDeposits.add(
              this._getDepositKey(deposit.inputToken.toNative(), originChainId, deposit.depositId.toString())
            );
          });
          return [originChainId, originEventsWithApiMessages.map(({ deposit }) => deposit)];
        })
      ),

      // For each destination chain, we need to index all `FilledRelay` events. This will let us know whether a deposit from the API has been filled by this relayer
      // (or any other relayer).
      Object.fromEntries(
        await mapAsync(this.config.relayerDestinationChains, async (destinationChainId) => {
          const provider = this.providersByChain[destinationChainId];
          const observedFills = this.observedFills[destinationChainId];

          const searchConfig = await this._getEventSearchConfig(destinationChainId);
          const destinationSpokePool = getSpokePool(destinationChainId).connect(provider);

          // Query all filledRelay events in the lookback. The lookback should only be a function of the max TTL of an API-served 3009 deposit.
          const destinationFilledRelayEvents = await paginatedEventQuery(
            destinationSpokePool,
            destinationSpokePool.filters.FilledRelay(),
            searchConfig
          );
          const fillEvents = destinationFilledRelayEvents.map((filledRelay) =>
            unpackFillEvent(spreadEventWithBlockNumber(filledRelay), destinationChainId)
          );

          // For each fill we observed, index it in our local set.
          fillEvents.forEach((fill) => observedFills.add(this._getFilledRelayKey(fill)));
          return [destinationChainId, fillEvents.flat()];
        })
      ),
    ]);
    return {
      observedFundsDeposited,
      observedFilledRelay,
    };
  }

  /**
   * Provide a simple yes/no on whether the deposit is eligible for an "instant fill".
   * @param deposit Deposit object to evaluate.
   * @todo Token prices are not considered here; this only works with USD stables.
   * @todo This is mostly placeholder; the logic here should be more sophisticated than simple USD limits.
   */
  protected fillImmediate(
    deposit: Pick<RelayData, "originChainId" | "outputToken" | "outputAmount"> & {
      destinationChainId: number;
      exclusivityParameter: number;
    },
    spokePool: string
  ): boolean {
    if (this._isCctpDeposit(deposit.originChainId, spokePool)) {
      return false;
    }

    // Verify that deposit.exclusivityParameter will produce an absolute exclusivityDeadline,
    // not relative to the deposit block timestamp.
    if (isExclusivityRelative(deposit.exclusivityParameter)) {
      return false;
    }

    const threshold = Number(
      process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${deposit.originChainId}`] ?? "0"
    );
    if (isNaN(threshold) || threshold === 0) {
      return;
    }

    if (!isStablecoin(deposit.outputToken, deposit.destinationChainId)) {
      return false;
    }

    const { decimals } = getTokenInfo(deposit.outputToken, deposit.destinationChainId);
    return toBNWei(threshold, decimals).gt(deposit.outputAmount);
  }

  /*
   * @notice For each CCTP deposit in the API messages, tries to find AuthorizationUsed(authorizer, nonce) via _findAuthorizationUsed and adds the corresponding deposit to observedDeposits so we do not re-submit.
   */
  private async updateObservedCctpDeposits(apiMessages: GaslessDepositMessage[]): Promise<void> {
    const cctpMessages = apiMessages.filter((msg) => this._isCctpDeposit(msg.originChainId, msg.spokePool));
    await mapAsync(cctpMessages, async (depositMessage) => {
      const { originChainId, depositId } = depositMessage;
      const inputToken = toAddressType(depositMessage.baseDepositData.inputToken, originChainId);
      const authorizer = getGaslessAuthorizerAddress(depositMessage);
      const nonce = getGaslessPermitNonce(depositMessage);
      const transactionHash = await this._findAuthorizationUsed(originChainId, inputToken, authorizer, nonce);
      if (!transactionHash) {
        return;
      }
      const depositKey = this._getDepositKey(inputToken.toNative(), originChainId, depositId.toString());
      this.observedDeposits[originChainId].add(depositKey);
    });
  }

  /*
   * @notice Polls the API and creates deposits/fills for all messages which are missing deposits/fills.
   */
  protected async evaluateApiSignatures(): Promise<void> {
    const handler = async (depositMessage: GaslessDepositMessage) => {
      const { originChainId, spokePool } = depositMessage;
      const {
        baseDepositData: { destinationChainId, fillDeadline, ...baseDepositData },
      } = depositMessage;
      const authorizer = getGaslessAuthorizerAddress(depositMessage);
      const nonce = getGaslessPermitNonce(depositMessage);

      const depositId = toBN(depositMessage.depositId);
      const inputToken = toAddressType(baseDepositData.inputToken, originChainId);
      const outputToken = toAddressType(baseDepositData.outputToken, destinationChainId);
      const inputAmount = toBN(baseDepositData.inputAmount);
      const outputAmount = toBN(baseDepositData.outputAmount);
      const { exclusivityParameter } = baseDepositData;

      const depositKey = this._getDepositKey(inputToken.toNative(), originChainId, depositId.toString());

      const log = (level: "debug" | "info" | "warn", message: string, args: Record<string, unknown> = {}) =>
        this.logger[level]({
          at,
          message,
          state: stateToStr(getState()),
          originChainId,
          depositId,
          amount: baseDepositData.outputAmount,
          token: baseDepositData.outputToken,
          authorizer,
          nonce,
          requestId: depositMessage.requestId,
          ...args,
        });

      const setState = (state: MessageState) => {
        const currentState = getState();
        log("debug", `State transition: ${stateToStr(currentState)} -> ${stateToStr(state)}.`, {
          currentState,
          nextState: state,
        });
        this._setState(depositKey, state);
      };
      const getState = () => {
        return this._getState(depositKey);
      };

      const messageState = getState();
      if (messageState !== MessageState.INITIAL) {
        return;
      }
      const isCctpDeposit = this._isCctpDeposit(originChainId, spokePool);
      const terminalStates = [MessageState.FILLED, MessageState.ERROR];
      const at = "GaslessRelayer#evaluateApiSignatures";
      const expired = () => getCurrentTime() >= fillDeadline;
      const [origin, destination] = [originChainId, destinationChainId].map(getNetworkName);
      const tStart = performance.now();

      let fillImmediate = false;
      let deposit: RelayData & { destinationChainId: number };
      let depositReceiptPromise: Promise<TransactionReceipt | null>;

      do {
        if (expired()) {
          log("warn", `Skipping expired deposit destined for ${origin}.`);
          setState(MessageState.ERROR);
        }

        const messageState = getState();
        switch (messageState) {
          case MessageState.INITIAL: {
            const valid = validateDeposit(
              originChainId,
              inputToken,
              inputAmount,
              destinationChainId,
              outputToken,
              outputAmount,
              this.config.refundFlowTestEnabled,
              this.config.allowedPeggedPairs
            );
            let nextState = MessageState.ERROR;
            if (!valid) {
              log("warn", `Rejected malformed deposit destined for ${origin}.`);
            } else {
              fillImmediate = this.fillImmediate(
                { originChainId, destinationChainId, outputToken, outputAmount, exclusivityParameter },
                spokePool
              );
              nextState = MessageState.DEPOSIT_SUBMIT;
            }
            setState(nextState);
            break;
          }

          case MessageState.DEPOSIT_SUBMIT: {
            if (fillImmediate) {
              const depositTx = buildGaslessDepositTx(depositMessage, this.getPeripheryContract(originChainId));
              const { succeed, reason } = await willSucceed(depositTx);
              if (!succeed) {
                log("warn", "Deposit simulation failed, falling back to standard path.", { reason });
                fillImmediate = false;
              }
            }

            depositReceiptPromise = this.initiateGaslessDeposit(depositMessage);
            const nextState = fillImmediate ? MessageState.FILL_PENDING : MessageState.DEPOSIT_CONFIRM;
            setState(nextState);
            break;
          }

          case MessageState.DEPOSIT_CONFIRM: {
            const depositReceipt = await depositReceiptPromise;
            if (isCctpDeposit) {
              const cctpDepositTx =
                depositReceipt?.transactionHash ??
                (await this._findAuthorizationUsed(originChainId, inputToken, authorizer, nonce));

              // CCTP deposits auto-finalise, so skip immediately to FILLED state.
              if (isDefined(cctpDepositTx)) {
                setState(MessageState.FILLED);
              } else {
                log("info", `Could not locate deposit on ${origin}.`);
                await delay(1);
                setState(MessageState.DEPOSIT_SUBMIT);
              }
              break;
            }

            let nextState: MessageState;
            // In immediate fill path, deposit is synthetic (built from API message).
            // We must verify the actual on-chain deposit exists before proceeding to FILLED.
            // If verification fails, the fill is unreimbursable and we must retry deposit.
            if (fillImmediate && isDefined(deposit)) {
              // Force verification: extract from receipt or find on-chain
              const verifiedDeposit = depositReceipt
                ? this._extractDepositFromTransactionReceipt(depositReceipt, originChainId)
                : await this._findDeposit(depositMessage);

              if (isDefined(verifiedDeposit)) {
                log("info", `Verified deposit on ${origin} after immediate fill.`);
                deposit = verifiedDeposit; // Replace synthetic with real
                nextState = MessageState.FILLED;
              } else {
                log("warn", `Deposit not found on ${origin} after immediate fill - unreimbursable fill risk!`);
                await delay(1);
                nextState = MessageState.DEPOSIT_SUBMIT;
              }
            } else {
              // Standard path: deposit should be null, populate it
              deposit ??= depositReceipt
                ? this._extractDepositFromTransactionReceipt(depositReceipt, originChainId)
                : await this._findDeposit(depositMessage);
              if (isDefined(deposit)) {
                nextState = MessageState.FILL_PENDING;
              } else {
                log("info", `Could not locate deposit on ${origin}.`);
                await delay(1);
                nextState = MessageState.DEPOSIT_SUBMIT;
              }
            }
            setState(nextState);
            break;
          }

          case MessageState.FILL_PENDING: {
            let fillStatus: FillStatus;

            if (deposit) {
              if (this.config.refundFlowTestEnabled && deposit.outputAmount.eq(MAX_UINT_VAL)) {
                log("info", `Skipped fill on ${destination} for ${origin} deposit (deposit refund test).`);
                setState(MessageState.FILLED);
                break;
              }

              const txnReceipt = await this.initiateFill(deposit, spokePool);
              if (isDefined(txnReceipt)) {
                log("info", `Completed fill on ${destination} for ${origin} deposit.`);
                fillStatus = FillStatus.Filled;
              }
            } else {
              // Immediate fill: construct deposit from API message (no on-chain event yet).
              deposit = buildSyntheticDeposit(depositMessage);
              const txnReceipt = await this.initiateFill(deposit, spokePool);
              if (isDefined(txnReceipt)) {
                log("info", `Completed immediate fill on ${destination} for ${origin} deposit.`);
                fillStatus = FillStatus.Filled;
              }
            }

            fillStatus ??= await relayFillStatus(
              this.spokePools[destinationChainId],
              deposit,
              "latest",
              destinationChainId
            );

            if (fillStatus === FillStatus.Filled) {
              log("info", `Recognised fill on ${destination}.`);
              const nextState = fillImmediate ? MessageState.DEPOSIT_CONFIRM : MessageState.FILLED;
              setState(nextState);
            } else {
              await delay(1);
            }
            break;
          }
        }
      } while (!terminalStates.includes(getState()));
      const tEnd = performance.now();
      const delta = (tEnd - tStart) / 1000;
      log("info", `Processed ${origin} depositId ${depositId} in ${delta} seconds.`);
    };

    const messageFilter = (deposit: GaslessDepositMessage): boolean => {
      if (!isDefined(this.observedDeposits[deposit.originChainId])) {
        return false;
      }

      const {
        baseDepositData: { inputToken },
        depositId,
        originChainId,
      } = deposit;
      const depositKey = this._getDepositKey(EvmAddress.from(inputToken).toNative(), originChainId, depositId);

      // If there's already known state for this deposit nonce, skip it.
      return !isDefined(this.messageState[depositKey]);
    };

    const apiMessages = await this._queryGaslessApi();
    await forEachAsync(apiMessages.filter(messageFilter), handler);
  }

  /*
   * @notice Builds and sends depositWithAuthorization tx, then waits for execution.
   * @returns The transaction receipt, or null if skipped or failed.
   */
  protected getPeripheryContract(originChainId: number): Contract {
    const contract = this.spokePoolPeripheries[originChainId];
    return this.depositSigners.length === 0
      ? contract.connect(this.baseSigner.connect(this.providersByChain[originChainId]))
      : contract;
  }

  protected async initiateGaslessDeposit(depositMessage: GaslessDepositMessage): Promise<TransactionReceipt | null> {
    const { originChainId, depositId } = depositMessage;

    const { destinationChainId, inputAmount, inputToken } = depositMessage.baseDepositData;
    const authorizer = getGaslessAuthorizerAddress(depositMessage);

    const spokePoolPeripheryContract = this.getPeripheryContract(originChainId);
    const _gaslessDeposit = buildGaslessDepositTx(depositMessage, spokePoolPeripheryContract);

    if (!this.config.sendingTransactionsEnabled) {
      this.logger.debug({
        at: "GaslessRelayer#initiateGaslessDeposit",
        message: "Sending transactions disabled, skipping",
      });
      return null;
    }

    const tokenInfo = getTokenInfo(toAddressType(inputToken, originChainId), originChainId);

    const gaslessDeposit = {
      ..._gaslessDeposit,
      message: "Completed gasless deposit 😎",
      mrkdwn: `Completed gasless deposit from ${getNetworkName(originChainId)} to ${getNetworkName(
        destinationChainId
      )} with authorizer ${blockExplorerLink(authorizer, originChainId)}, input amount ${createFormatFunction(
        2,
        4,
        false,
        tokenInfo.decimals
      )(inputAmount)} ${tokenInfo.symbol}, and deposit ID ${depositId}`,
    };

    const txReceipt = await sendAndConfirmTransaction(
      gaslessDeposit,
      this.transactionClient,
      this.depositSigners.length > 0
    );
    if (!isDefined(txReceipt)) {
      this.logger.warn({
        at: "GaslessRelayer#initiateGaslessDeposit",
        message: "Failed to submit gasless deposit",
        depositId,
        originChainId,
        destinationChainId,
        inputToken,
        inputAmount,
      });
      this.logger.debug({
        at: "GaslessRelayer#initiateGaslessDeposit",
        message: "Failed to submit gasless deposit. Debug information:",
        depositMessage,
      });
    }
    return txReceipt;
  }

  /*
   * @notice Builds and sends the associated `fillRelay` call from the input API message.
   */
  protected async initiateFill(
    deposit: RelayData & { destinationChainId: number },
    originChainSpokePool: string
  ): Promise<TransactionReceipt | null> {
    const { originChainId, depositId, destinationChainId, outputToken, outputAmount, inputToken, inputAmount } =
      deposit;

    assert(!this._isCctpDeposit(originChainId, originChainSpokePool), "Cannot fill CCTP deposit");

    // Do sanity checks. We should never fill a deposit with outputAmount > inputAmount.
    const outputTokenInfo = getTokenInfo(outputToken, destinationChainId);
    const inputTokenInfo = getTokenInfo(inputToken, originChainId);
    const inputAmountInOutputDecimals = ConvertDecimals(inputTokenInfo.decimals, outputTokenInfo.decimals)(inputAmount);
    if (this.config.refundFlowTestEnabled && outputAmount.eq(MAX_UINT_VAL)) {
      this.logger.info({
        at: "GaslessRelayer#initiateFill",
        message: "Refund flow test: skipping fill (deposit already made).",
        depositId,
      });
      return null;
    }
    assert(inputAmountInOutputDecimals.gte(outputAmount), "Cannot fill deposit with outputAmount > inputAmount");
    const tokenPairAllowed = isAllowedGaslessPair(
      inputToken,
      outputToken,
      originChainId,
      destinationChainId,
      this.config.allowedPeggedPairs
    );
    assert(
      tokenPairAllowed,
      "Cannot fill deposit with mismatching input/output tokens (not same L1 or in allowedPeggedPairs)."
    );

    const spokePool = this.spokePools[destinationChainId];

    const _gaslessFill = buildGaslessFillRelayTx(deposit, spokePool, originChainId, this.signerAddress);

    if (!this.config.sendingTransactionsEnabled) {
      this.logger.debug({
        at: "GaslessRelayer#initiateFill",
        message: "Sending transactions disabled, skipping",
      });
      return null;
    }

    const gaslessFill = {
      ..._gaslessFill,
      message: "Completed gasless fill 🔮",
      mrkdwn: `Completed gasless fill from ${getNetworkName(originChainId)} to ${getNetworkName(
        destinationChainId
      )} with output amount ${createFormatFunction(2, 4, false, outputTokenInfo.decimals)(outputAmount)} ${
        outputTokenInfo.symbol
      } and deposit ID ${depositId}`,
    };

    const txReceipt = await sendAndConfirmTransaction(gaslessFill, this.transactionClient);
    if (!isDefined(txReceipt)) {
      this.logger.warn({
        at: "GaslessRelayer#initiateFill",
        message: "Failed to submit gasless fill",
        depositId,
      });
    }
    return txReceipt;
  }

  /*
   * @notice Queries the API for all pending gasless transactions. By default, do not retry since this endpoing is being polled.
   */
  protected async _queryGaslessApi(retriesRemaining = 0): Promise<GaslessDepositMessage[]> {
    let apiResponseData: { deposits: APIGaslessDepositResponse[] } | undefined = undefined;
    try {
      apiResponseData = await this.api.get<{ deposits: APIGaslessDepositResponse[] }>(this.config.apiEndpoint, {});
    } catch {
      // Error log should have been emitted in AcrossSwapApiClient.
    }
    if (!isDefined(apiResponseData)) {
      return retriesRemaining > 0 ? this._queryGaslessApi(--retriesRemaining) : [];
    }
    return restructureGaslessDeposits(apiResponseData.deposits);
  }

  /*
   * @notice Finds a deposit via EIP-3009 AuthorizationUsed on the token, then extracts the deposit from the tx receipt.
   */
  protected async _findDepositByAuthorization(
    originChainId: number,
    inputToken: Address,
    authorizer: string,
    nonce: string
  ): Promise<Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber"> | undefined> {
    const provider = this.providersByChain[originChainId];
    const transactionHash = await this._findAuthorizationUsed(originChainId, inputToken, authorizer, nonce);
    if (!transactionHash) {
      return undefined;
    }
    // Otherwise, find the associated deposit event.
    const transactionReceipt = await provider.getTransactionReceipt(transactionHash);
    return this._extractDepositFromTransactionReceipt(transactionReceipt, originChainId);
  }

  private async _findAuthorizationUsed(
    originChainId: number,
    inputToken: Address,
    authorizer: string,
    nonce: string
  ): Promise<string | undefined> {
    const provider = this.providersByChain[originChainId];
    const authToken = new Contract(inputToken.toNative(), EIP3009_ABI, provider);
    const searchConfig = await this._getEventSearchConfig(originChainId);
    const spentNonces = await paginatedEventQuery(
      authToken,
      authToken.filters.AuthorizationUsed(authorizer, nonce),
      searchConfig
    );
    if (spentNonces.length === 0) {
      // The nonce is not used, so exit.
      return undefined;
    }
    assert(spentNonces.length === 1, "Same user cannot spend same nonce");
    return spentNonces[0].transactionHash;
  }

  /*
   * @notice Finds the whole deposit event for a non-CCTP message: Permit2 by depositId on SpokePool, EIP-3009 by AuthorizationUsed then tx receipt.
   */
  private async _findDeposit(
    depositMessage: GaslessDepositMessage
  ): Promise<Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber"> | undefined> {
    const { originChainId, depositId, spokePool } = depositMessage;
    assert(
      !this._isCctpDeposit(originChainId, spokePool),
      "_findDeposit must not be used for CCTP deposits; use _findAuthorizationUsed"
    );

    if (depositMessage.permitType === "permit2") {
      return this._findDepositByDepositId(originChainId, depositId);
    }

    const inputToken = toAddressType(depositMessage.baseDepositData.inputToken, originChainId);
    const authorizer = getGaslessAuthorizerAddress(depositMessage);
    const nonce = getGaslessPermitNonce(depositMessage);

    return this._findDepositByAuthorization(originChainId, inputToken, authorizer, nonce);
  }

  /*
   * @notice Finds a deposit by depositId (and optional depositor) by querying SpokePool FundsDeposited events.
   * @dev Used for Permit2 flow where there is no AuthorizationUsed on the token; the SpokePool still emits FundsDeposited when depositWithPermit2 is used.
   */
  private async _findDepositByDepositId(
    originChainId: number,
    depositId: string
  ): Promise<Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber"> | undefined> {
    const provider = this.providersByChain[originChainId];
    const originSpokePool = this.spokePools[originChainId].connect(provider);
    const searchConfig = await this._getEventSearchConfig(originChainId);
    const events = await paginatedEventQuery(
      originSpokePool,
      originSpokePool.filters.FundsDeposited(null, null, null, null, null, toBN(depositId)),
      searchConfig
    );
    if (events.length === 0) {
      return undefined;
    }
    return unpackDepositEvent(spreadEventWithBlockNumber(events[0]), originChainId);
  }

  /*
   * @notice Finds if a deposit has been filled on the deposit's destination chain.
   */
  private async _findFill(deposit: RelayData & { destinationChainId: number }): Promise<FillWithBlock | undefined> {
    const { destinationChainId, depositId } = deposit;
    const dstProvider = this.providersByChain[destinationChainId];
    const searchConfig = await this._getEventSearchConfig(destinationChainId);
    const spokePool = getSpokePool(destinationChainId).connect(dstProvider);
    const filledRelay = await paginatedEventQuery(
      spokePool,
      spokePool.filters.FilledRelay(undefined, undefined, undefined, undefined, undefined, undefined, depositId),
      searchConfig
    );

    if (filledRelay.length == 0) {
      return undefined;
    }
    // If we assert here, then we have observed an invalid fill, so we should stop trying to fill this deposit.
    assert(filledRelay.length === 1, "Observed multiple fills with matching deposit IDs");
    return unpackFillEvent(spreadEventWithBlockNumber(filledRelay[0]), destinationChainId);
  }

  /*
   * @notice Extracts the deposit event from an input transaction receipt. This function assumes the input transaction receipt does indeed contain a deposit in the logs.
   */
  protected _extractDepositFromTransactionReceipt(
    transactionReceipt: TransactionReceipt,
    originChainId: number
  ): Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber"> {
    const originSpokePool = this.spokePools[originChainId];
    const fundsDepositedSignature = originSpokePool.interface.getEventTopic(DEPOSIT_EVENT);
    const depositLogs = transactionReceipt.logs.filter(
      ({ address, topics }) => address === originSpokePool.address && topics[0] === fundsDepositedSignature
    );

    assert(depositLogs.length === 1, "Deposit with authorization should only contain a single FundsDeposited event.");
    // We must decode the log data manually and tell `spreadEventWithBlockNumber` that this log is a `FundsDeposited` event.
    const depositLog = {
      event: DEPOSIT_EVENT,
      ...depositLogs[0],
      ...originSpokePool.interface.parseLog(depositLogs[0]),
    };
    return unpackDepositEvent(spreadEventWithBlockNumber(depositLog), originChainId);
  }

  /*
   * @notice Gets the event search config for the input network.
   * @returns an EventSearchConfig type based on the relayer's lookback and current chain's height.
   */
  private async _getEventSearchConfig(chainId: number): Promise<EventSearchConfig> {
    const provider = this.providersByChain[chainId];
    const to = await provider.getBlock("latest");
    const from = await getBlockForTimestamp(this.logger, chainId, to.timestamp - this.config.depositLookback);
    return {
      to: to.number,
      from,
      maxLookBack: this.config.maxBlockLookBack[chainId],
    };
  }

  /*
   * @notice Returns true if the deposit is a CCTP gasless deposit (API spokePool differs from our default SpokePool for the origin chain).
   * For CCTP we still submit the deposit on SpokePoolPeriphery but never perform a fill.
   */
  private _isCctpDeposit(originChainId: number, spokePool: string): boolean {
    const defaultSpokePool = this.spokePools[originChainId];
    if (!defaultSpokePool) {
      return false;
    }
    return !compareAddressesSimple(spokePool, defaultSpokePool.address);
  }

  /*
   * @notice Gets the key for `this.observedDeposits` from a relevant 3009 authorization.
   */
  protected _getDepositKey(token: string, originChainId: number, depositId: string): string {
    return `${token}:${originChainId}:${depositId}`;
  }

  /*
   * @notice Sets the message state for a deposit. Can be overridden by subclasses to observe state changes.
   */
  protected _setState(depositKey: string, state: MessageState): void {
    this.messageState[depositKey] = state;
  }

  /*
   * @notice Gets the message state for a deposit, initializing to INITIAL if not set.
   */
  protected _getState(depositKey: string): MessageState {
    return (this.messageState[depositKey] ??= MessageState.INITIAL);
  }

  /*
   * @notice Gets the key for `this.observedFills` from a relevant FilledRelay event.
   * @dev We key on the origin chain and depositId only since this is what uniquely identifies a deposit on an origin chain for a specific user (the only way to have a collision here with
   * a valid, unfilled deposit is by finding a collision in keccak).
   */
  private _getFilledRelayKey(filledRelay: Pick<FillWithBlock, "originChainId" | "depositId">): string {
    const { originChainId, depositId } = filledRelay;
    return `${originChainId}:${depositId}`;
  }
}
