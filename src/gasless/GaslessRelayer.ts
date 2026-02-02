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
  mapAsync,
  TOKEN_SYMBOLS_MAP,
  TransactionReceipt,
  runTransaction,
  bnZero,
} from "../utils";
import { GaslessDepositMessage, FillWithBlock, AuthorizationUsed, BaseDepositData } from "../interfaces";
import { CHAIN_MAX_BLOCK_LOOKBACK, CONTRACT_ADDRESSES } from "../common";
import { AcrossSwapApiClient } from "../clients";
import EIP3009_ABI from "../common/abi/EIP3009.json";
import { getDepositWithAuthorizationArgs } from "../utils/GaslessUtils";

/**
 * Independent relayer bot which processes EIP-3009 signatures into deposits and corresponding fills.
 */
export class GaslessRelayer {
  private abortController = new AbortController();
  private initialized = false;

  private providersByChain: { [chainId: number]: Provider } = {};
  private observedNonces: { [chainId: number]: Set<string> } = {}; // Indexed by `${authorizer}:${nonce}`
  private observedFills: { [chainId: number]: Set<string> } = {}; // Indexed by relayDataHash

  private api: AcrossSwapApiClient;

  private providersByChain: { [chainId: number]: Provider } = {};
  // The object is indexed by `chainId`. An `AuthorizationUsed` event is marked by adding `${token}:${authorizer}:${nonce}` to the respective chain's set.
  private observedNonces: { [chainId: number]: Set<string> } = {};
  // The object is indexed by `chainId`. A `FilledRelay` event is marked by adding `${originChainId}:${depositId}` to the respective chain's set.
  private observedFills: { [chainId: number]: Set<string> } = {};

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
    // Initialize the map with newly allocated sets.
    await forEachAsync(this.config.relayerOriginChains, async (chainId) => {
      this.providersByChain[chainId] = await getProvider(chainId);
      this.observedNonces[chainId] = new Set<string>();
    });
    await forEachAsync(this.config.relayerDestinationChains, async (chainId) => {
      this.providersByChain[chainId] ??= await getProvider(chainId);
      this.observedFills[chainId] = new Set<string>();
    });
    // Update our observed signatures/fills up until `this.depositLookback`.
    await this.updateObserved();

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
  private async updateObserved(): Promise<void> {
    // If a signature is spent, then the deposit must also have been initiated since the `receiveWithAuthorization` signature
    // can only be redeemed by the periphery contract.
    await Promise.allSettled([
      // For each origin chain, we need to index all used 3009 nonces. If a nonce from a signature has been used, then there must have been an associated
      // Across deposit.
      forEachAsync(this.config.relayerOriginChains, async (originChainId) => {
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
        originAuthUsedEvents.flat().forEach((event) => observedNonces.add(this._getNonceKey(event.token, event.auth)));
      }),
      // For each destination chain, we need to index all `FilledRelay` events. This will let us know whether a deposit from the API has been filled by this relayer
      // (or any other relayer).
      forEachAsync(this.config.relayerDestinationChains, async (destinationChainId) => {
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
      }),
    ]);
  }

  /*
   * @notice Polls the API and creates deposits/fills for all messages which are missing deposits/fills.
   */
  private async evaluateApiSignatures(): Promise<void> {
    const apiMessages = await this.api.get<GaslessDepositMessage[]>(this.config.apiEndpoint, {}); // Query the API.
    await forEachAsync(
      // Filter if we do not recognize the chain ID.
      apiMessages.filter(({ swapTx }) => isDefined(this.observedNonces[swapTx.chainId])),
      async (depositMessage) => {
        const { swapTx } = depositMessage;
        const nonceSet = this.observedNonces[swapTx.chainId];
        const depositData = this._extractDepositData(depositMessage);
        const depositNonce = this._getNonceKey(depositData.inputToken, {
          authorizer: swapTx.data.permit.message.from!,
          nonce: swapTx.data.permit.message.nonce!,
        }); // add ! to make sure deposit data is defined.
        // If the deposit has been observed, then exit.
        if (nonceSet.has(depositNonce)) {
          return;
        }

        // Mark the signature as observed.
        nonceSet.add(depositNonce);

        // Initiate the deposit (depositWithAuthorization) and wait for tx to be executed.
        const receipt = await this.initiateGaslessDeposit(depositMessage);
        if (!receipt) {
          return;
        }
        this.logger.info({
          at: "GaslessRelayer#evaluateApiSignatures",
          message: "Deposit with authorization executed",
          requestId: depositMessage.requestId,
          txHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
        });

        // Fill the deposit.
      }
    );
  }

  /*
   * @notice Builds and sends depositWithAuthorization tx, then waits for execution.
   * @returns The transaction receipt, or null if skipped or failed.
   */
  private async initiateGaslessDeposit(message: GaslessDepositMessage): Promise<TransactionReceipt | null> {
    const { chainId } = message.swapTx;
    const provider = this.providersByChain[chainId];

    if (!isDefined(provider)) {
      this.logger.warn({
        at: "GaslessRelayer#initiateGaslessDeposit",
        message: "No provider for chainId, skipping",
        chainId,
      });
      return null;
    }

    if (!this.config.sendingTransactionsEnabled) {
      return null;
    }

    const signer = this.baseSigner.connect(provider);
    const spokePoolPeripheryContract = new Contract(
      CONTRACT_ADDRESSES[chainId].spokePoolPeriphery.address,
      CONTRACT_ADDRESSES[chainId].spokePoolPeriphery.abi,
      signer
    );

    try {
      const txResponse = await runTransaction(
        this.logger,
        spokePoolPeripheryContract,
        "depositWithAuthorization",
        getDepositWithAuthorizationArgs(message),
        bnZero
      );
      return txResponse.wait();
    } catch (err) {
      this.logger.error({
        at: "GaslessRelayer#initiateGaslessDeposit",
        message: "Failed to execute depositWithAuthorization",
        requestId: message.requestId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
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

  /*
   * @notice Extracts the BaseDepositData from the deposit or swap witness.
   */
  private _extractDepositData(message: GaslessDepositMessage): BaseDepositData {
    return message.swapTx.data.witness.BridgeWitness.data.baseDepositData;
  }
}
