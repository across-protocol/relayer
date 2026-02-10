import winston from "winston";
import { GaslessRelayerConfig } from "./GaslessRelayerConfig";
import {
  isDefined,
  getRedisCache,
  delay,
  Signer,
  scheduleTask,
  forEachAsync,
  Provider,
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
  TOKEN_SYMBOLS_MAP,
  TransactionReceipt,
  EvmAddress,
  toBN,
  TransactionResponse,
  blockExplorerLink,
  getNetworkName,
  submitTransaction,
  getTokenInfo,
  createFormatFunction,
  toAddressType,
  getSpokePoolPeriphery,
  getL1TokenAddress,
  assert,
} from "../utils";
import {
  APIGaslessDepositResponse,
  FillWithBlock,
  AuthorizationUsed,
  DepositWithBlock,
  GaslessDepositMessage,
} from "../interfaces";
import { CHAIN_MAX_BLOCK_LOOKBACK } from "../common";
import { AcrossSwapApiClient, TransactionClient } from "../clients";
import EIP3009_ABI from "../common/abi/EIP3009.json";
import { buildGaslessDepositTx, buildGaslessFillRelayTx, restructureGaslessDeposits } from "../utils/GaslessUtils";

type GaslessRelayerUpdate = {
  observedAuthUsed: { [chainId: number]: { token: string; auth: AuthorizationUsed }[] };
  observedFilledRelay: { [chainId: number]: FillWithBlock[] };
};
const DEPOSIT_EVENT = "FundsDeposited";

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class GaslessRelayer {
  private abortController = new AbortController();
  private initialized = false;

  private providersByChain: { [chainId: number]: Provider } = {};
  // The object is indexed by `chainId`. An `AuthorizationUsed` event is marked by adding `${token}:${authorizer}:${nonce}` to the respective chain's set.
  private observedNonces: { [chainId: number]: Set<string> } = {};
  // The object is indexed by `chainId`. A `FilledRelay` event is marked by adding `${originChainId}:${depositId}` to the respective chain's set.
  private observedFills: { [chainId: number]: Set<string> } = {};
  // The object is indexed by `chainId`. A SpokePoolPeriphery contract is indexed by the chain ID.
  private spokePoolPeripheries: { [chainId: number]: Contract } = {};
  // The object is indexed by `chainId`. A SpokePool contract is indexed by the chain ID.
  private spokePools: { [chainId: number]: Contract } = {};

  private api: AcrossSwapApiClient;
  private signerAddress: EvmAddress;

  private transactionClient;
  private redisCache;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: GaslessRelayerConfig,
    readonly baseSigner: Signer
  ) {
    this.api = new AcrossSwapApiClient(this.logger, this.config.apiTimeoutOverride);
    this.transactionClient = new TransactionClient(this.logger);
  }

  /*
   * @notice Initializes a GaslessRelayer instance.
   */
  public async initialize(): Promise<void> {
    this.logger.debug({
      at: "GaslessRelayer#initialize",
      message: "Initializing GaslessRelayer",
    });

    // Set the signer address.
    this.signerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.redisCache = await getRedisCache(this.logger);

    // Initialize the map with newly allocated sets.
    await forEachAsync(this.config.relayerOriginChains, async (chainId) => {
      const provider = await getProvider(chainId);
      this.providersByChain[chainId] = provider;
      this.observedNonces[chainId] = new Set<string>();
      this.spokePoolPeripheries[chainId] = getSpokePoolPeriphery(chainId).connect(this.baseSigner.connect(provider));
    });
    await forEachAsync(this.config.relayerDestinationChains, async (chainId) => {
      this.providersByChain[chainId] ??= await getProvider(chainId);
      this.observedFills[chainId] = new Set<string>();
      this.spokePools[chainId] = getSpokePool(chainId).connect(this.baseSigner.connect(this.providersByChain[chainId]));
    });

    // Update our observed signatures/fills up until `this.depositLookback`.
    const observedEvents = await this.updateObserved();

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
    const unfilledDeposits = initialMessages.filter((depositMessage) => {
      const { originChainId, depositId, permit } = depositMessage;
      const { destinationChainId } = depositMessage.baseDepositData;

      const nonceKey = this._getNonceKey(permit.domain.verifyingContract, {
        authorizer: permit.message.from!,
        nonce: permit.message.nonce!,
      });
      const fillKey = this._getFilledRelayKey({ originChainId, depositId: toBN(depositId) });
      return this.observedNonces[originChainId].has(nonceKey) && !this.observedFills[destinationChainId].has(fillKey);
    });

    this.logger.debug({
      at: "GaslessRelayer#initialize",
      message: "Found unfilled deposits",
      unfilledDeposits: unfilledDeposits.length,
    });

    await mapAsync(unfilledDeposits, async (depositMessage) => {
      const { originChainId, permit, baseDepositData } = depositMessage;
      const { inputToken } = baseDepositData;
      const { from, nonce } = permit.message;

      const provider = this.providersByChain[originChainId];
      const authUsedEvent = observedEvents.observedAuthUsed[originChainId].find(
        (authUsed) =>
          authUsed.token === inputToken && authUsed.auth.nonce === nonce && authUsed.auth.authorizer === from
      );
      assert(
        isDefined(authUsedEvent),
        "Inconsistent data between this.observedNonces and return data from gaslessRelayer.updateObserved()"
      );
      const transactionReceipt = await provider.getTransactionReceipt(authUsedEvent.auth.txnRef);
      const correspondingDeposit = this._extractDepositFromTransactionReceipt(transactionReceipt, originChainId);
      await this.initiateFill(correspondingDeposit);
    });
    this.initialized = true;
  }

  /*
   * @notice Polls the Across gasless API and starts background deposit/fill tasks.
   */
  public pollAndExecute(): void {
    scheduleTask(() => this.evaluateApiSignatures(), this.config.apiPollingInterval, this.abortController.signal);
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

    // Set the active instance immediately on arrival here. This function will poll until it reaches the max amount of
    // runs or it is interrupted by another process.
    if (isDefined(runIdentifier) && isDefined(botIdentifier)) {
      await this.redisCache.set(botIdentifier, runIdentifier, maxCycles * pollingDelay);
      for (let run = 0; run < maxCycles; run++) {
        const currentBot = await this.redisCache.get(botIdentifier);
        if (currentBot !== runIdentifier) {
          this.logger.debug({
            at: "GaslessRelayer#waitForDisconnect",
            message: `Handing over ${runIdentifier} instance to ${currentBot} for ${botIdentifier}`,
            run,
          });
          this.abortController.abort();
          return;
        }
        await delay(pollingDelay);
      }
      // If we finish looping without receiving a handover signal, still exit so that we won't await the other promise forever.
      this.abortController.abort();
    }
  }

  /*
   * @notice Performs an initial lookback to determine which signatures have been observed/processed onchain.
   */
  private async updateObserved(): Promise<GaslessRelayerUpdate> {
    // If a signature is spent, then the deposit must also have been initiated since the `receiveWithAuthorization` signature
    // can only be redeemed by the periphery contract.
    const [observedAuthUsed, observedFilledRelay] = await Promise.all([
      // For each origin chain, we need to index all used 3009 nonces. If a nonce from a signature has been used, then there must have been an associated
      // Across deposit.
      Object.fromEntries(
        await mapAsync(this.config.relayerOriginChains, async (originChainId) => {
          const provider = this.providersByChain[originChainId];
          const observedNonces = this.observedNonces[originChainId];

          const searchConfig = await this._getEventSearchConfig(originChainId);
          // For each relayer token (which we assume satisfies EIP-3009), collect all the `AuthorizationUsed` events.

          const originAuthUsedEvents = await mapAsync(this.config.relayerTokenSymbols, async (symbol) => {
            const token = TOKEN_SYMBOLS_MAP[symbol]?.addresses?.[originChainId];
            if (!isDefined(token)) {
              return;
            }
            const tokenContract = new Contract(token, EIP3009_ABI, provider);
            const authorizationEvents = await paginatedEventQuery(
              tokenContract,
              tokenContract.filters.AuthorizationUsed(),
              searchConfig
            );
            return authorizationEvents.map((event) => {
              return { token, auth: spreadEventWithBlockNumber(event) as AuthorizationUsed };
            });
          });
          // Update the observed nonces set.
          originAuthUsedEvents
            .flat()
            .forEach((event) => observedNonces.add(this._getNonceKey(event.token, event.auth)));
          return [originChainId, originAuthUsedEvents.flat()];
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
      observedAuthUsed,
      observedFilledRelay,
    };
  }

  /*
   * @notice Polls the API and creates deposits/fills for all messages which are missing deposits/fills.
   */
  private async evaluateApiSignatures(): Promise<void> {
    const apiMessages = await this._queryGaslessApi();
    await forEachAsync(
      // Filter if we do not recognize the chain ID.
      apiMessages.filter(({ originChainId }) => isDefined(this.observedNonces[originChainId])),
      async (depositMessage) => {
        const { originChainId, depositId, permit } = depositMessage;
        const { destinationChainId, inputToken, outputToken, inputAmount, outputAmount } =
          depositMessage.baseDepositData;
        const { from: authorizer, nonce } = permit.message;

        const nonceSet = this.observedNonces[originChainId];
        const fillSet = this.observedFills[destinationChainId];
        const depositNonce = this._getNonceKey(inputToken, {
          authorizer,
          nonce,
        });

        if (!nonceSet.has(depositNonce)) {
          this.logger.debug({
            at: "GaslessRelayer#evaluateApiSignatures",
            message: "Deposit not observed, initiating deposit",
            depositId,
            depositNonce,
          });

          // Mark the signature as observed.
          nonceSet.add(depositNonce);

          // Ensure that the input token is the same as the output token.
          const inputTokenAddress = toAddressType(inputToken, originChainId);
          const inputTokenL1Address = getL1TokenAddress(inputTokenAddress, this.config.hubPoolChainId);
          const outputTokenAddress = toAddressType(outputToken, destinationChainId);
          const outputTokenL1Address = getL1TokenAddress(outputTokenAddress, this.config.hubPoolChainId);
          // If the input token is different from the output token, then keep the deposit as observed and do not submit a deposit.
          if (!inputTokenL1Address.eq(outputTokenL1Address)) {
            this.logger.debug({
              at: "GaslessRelayer#evaluateApiSignatures",
              message: "Deposit input token is different from deposit output token. Skipping deposit.",
              depositId,
              depositNonce,
              inputToken,
              outputToken,
            });
            return;
          }
          // If the input amount is less than the output amount, then keep the deposit as observed and do not submit a deposit.
          if (toBN(inputAmount).lt(toBN(outputAmount))) {
            this.logger.debug({
              at: "GaslessRelayer#evaluateApiSignatures",
              message: "Deposit inputAmount > ouputAmount. Skipping deposit.",
              depositId,
              depositNonce,
              inputAmount,
              outputAmount,
            });
            return;
          }

          // Initiate the deposit (depositWithAuthorization) and wait for tx to be executed.
          const receipt = await this.initiateGaslessDeposit(depositMessage);

          let depositEvent: Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber"> | undefined =
            undefined;
          if (!receipt || !receipt.status) {
            this.logger.warn({
              at: "GaslessRelayer#evaluateApiSignatures",
              message: "Failed to initiate deposit. Checking for relayer collision.",
              depositId,
              depositNonce,
            });

            const associatedDeposit = await this._findDeposit(originChainId, inputToken, authorizer, nonce);
            // If the deposit fails, and if we did not see the deposit mined, then mark the signature as not observed so that we can retry.
            if (!isDefined(associatedDeposit)) {
              nonceSet.delete(depositNonce);
              return;
            }
            depositEvent = associatedDeposit;
          } else {
            depositEvent = this._extractDepositFromTransactionReceipt(receipt, originChainId);
          }
          assert(
            isDefined(depositEvent),
            "We must have observed a matching deposit event in order to proceed with filling"
          );

          this.logger.debug({
            at: "GaslessRelayer#evaluateApiSignatures",
            message: "Deposit with authorization executed",
            depositId,
            txHash: depositEvent.txnRef,
            blockNumber: depositEvent.blockNumber,
          });

          const fillKey = this._getFilledRelayKey({ originChainId, depositId: toBN(depositId) });

          // If the fill has been observed, exit. All fill transactions initiated by this bot should generally never collide here, but it is possible for another party with knowledge of the
          // witness to prefill any deposit, causing the fill to be known while the deposit is still yet to be executed.
          if (fillSet.has(fillKey)) {
            this.logger.warn({
              at: "GaslessRelayer#evaluateApiSignatures",
              message: "Out of order fill observed. Skipping",
              depositId,
            });
            return;
          }

          this.logger.debug({
            at: "GaslessRelayer#evaluateApiSignatures",
            message: "Fill not observed, initiating fill",
            depositId,
          });

          // We do not need to evaluate the response of `initiateFill` since the TransactionClient should handle the logging. A `null` response
          // here means that we did not send a transaction because of config.
          await this.initiateFill(depositEvent);
          // There is no race on setting the fill in the fill set, so we can set it after the fill transaction is sent.
          fillSet.add(fillKey);
        }
      }
    );
  }

  /*
   * @notice Builds and sends depositWithAuthorization tx, then waits for execution.
   * @returns The transaction receipt, or null if skipped or failed.
   */
  private async initiateGaslessDeposit(depositMessage: GaslessDepositMessage): Promise<TransactionReceipt | null> {
    const { originChainId, depositId, permit, requestId } = depositMessage;
    const { destinationChainId, inputAmount, inputToken } = depositMessage.baseDepositData;

    const spokePoolPeripheryContract = this.spokePoolPeripheries[originChainId];

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
      )} with authorizer ${blockExplorerLink(permit.message.from, originChainId)}, input amount ${createFormatFunction(
        2,
        4,
        false,
        tokenInfo.decimals
      )(inputAmount)} ${tokenInfo.symbol}, and deposit ID ${depositId}`,
    };

    try {
      const txResponse = await submitTransaction(gaslessDeposit, this.transactionClient);
      // Since we called `ensureConfirmation` in the transaction client, the receipt should exist, so `.wait()` should have already resolved.
      // We only sent one transaction, so only take the first element of `txResponses`.
      return txResponse.wait();
    } catch (err) {
      // We will reach this code block if, after polling for transaction confirmation, we still do not see the receipt onchain.
      this.logger.warn({
        at: "GaslessRelayer#initiateGaslessDeposit",
        message: "Failed to execute depositWithAuthorization",
        requestId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /*
   * @notice Builds and sends the associated `fillRelay` call from the input API message.
   */
  private async initiateFill(
    deposit: Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber">
  ): Promise<TransactionResponse | null> {
    const { originChainId, depositId, destinationChainId, outputToken, outputAmount, inputToken, inputAmount } =
      deposit;

    // Do sanity checks. We should never fill a deposit with outputAmount > inputAmount.
    assert(inputAmount.gte(outputAmount), "Cannot fill deposit with outputAmount > inputAmount");
    // We should also never fill a deposit with mismatching input/output tokens.
    const inputTokenL1Address = getL1TokenAddress(inputToken, originChainId);
    const outputTokenL1Address = getL1TokenAddress(outputToken, destinationChainId);
    assert(inputTokenL1Address.eq(outputTokenL1Address), "Cannot fill deposit with mismatching input/output tokens.");

    const spokePool = this.spokePools[destinationChainId];

    const _gaslessFill = buildGaslessFillRelayTx(deposit, spokePool, originChainId, this.signerAddress);

    if (!this.config.sendingTransactionsEnabled) {
      this.logger.debug({
        at: "GaslessRelayer#initiateFill",
        message: "Sending transactions disabled, skipping",
      });
      return null;
    }

    const tokenInfo = getTokenInfo(outputToken, destinationChainId);
    const gaslessFill = {
      ..._gaslessFill,
      message: "Completed gasless fill 🔮",
      mrkdwn: `Completed gasless fill from ${getNetworkName(originChainId)} to ${getNetworkName(
        destinationChainId
      )} with output amount ${createFormatFunction(2, 4, false, tokenInfo.decimals)(outputAmount)} ${
        tokenInfo.symbol
      } and deposit ID ${depositId}`,
    };

    return this.transactionClient.submit(destinationChainId, [gaslessFill]);
  }

  /*
   * @notice Queries the API for all pending gasless transactions. By default, do not retry since this endpoing is being polled.
   */
  private async _queryGaslessApi(retriesRemaining = 0): Promise<GaslessDepositMessage[]> {
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
   * @notice Finds a deposit for an input deposit ID/origin chain ID. This should uniquely identify any origin chain deposit.
   * @dev It is possible for there to be duplicate deposits when deposits are made with deterministic deposit IDs. This function will return all
   * such deposits.
   */
  private async _findDeposit(
    originChainId: number,
    inputToken: string,
    authorizer: string,
    nonce: string
  ): Promise<Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber"> | undefined> {
    const provider = this.providersByChain[originChainId];
    const authToken = new Contract(inputToken, EIP3009_ABI, provider);
    const searchConfig = await this._getEventSearchConfig(originChainId);
    const spentNonces = await paginatedEventQuery(
      authToken,
      authToken.filters.AuthorizationUsed(authorizer, nonce),
      searchConfig
    ); // 2nd index is `nonce`.
    if (spentNonces.length === 0) {
      // The nonce is not used, so exit.
      return undefined;
    }
    assert(spentNonces.length === 1, "Same user cannot spend same nonce");
    // Otherwise, find the associated deposit event.
    const transactionReceipt = await provider.getTransactionReceipt(spentNonces[0].transactionHash);
    return this._extractDepositFromTransactionReceipt(transactionReceipt, originChainId);
  }

  /*
   * @notice Extracts the deposit event from an input transaction receipt. This function assumes the input transaction receipt does indeed contain a deposit in the logs.
   */
  private _extractDepositFromTransactionReceipt(
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
      maxLookBack: CHAIN_MAX_BLOCK_LOOKBACK[chainId],
    };
  }

  /*
   * @notice Gets the key for `this.observedNonces` from a relevant 3009 authorization.
   */
  private _getNonceKey(token: string, authorization: { authorizer: string; nonce: string }): string {
    return `${token}:${authorization.authorizer}:${authorization.nonce}`;
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
