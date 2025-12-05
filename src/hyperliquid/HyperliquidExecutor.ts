import winston from "winston";
import { utils as ethersUtils } from "ethers";
import { HyperliquidExecutorConfig } from "./HyperliquidExecutorConfig";
import {
  Contract,
  Provider,
  isDefined,
  CHAIN_IDs,
  getTokenInfo,
  EvmAddress,
  getHlInfoClient,
  getSpotMeta,
  getDstOftHandler,
  getL2Book,
  getDstCctpHandler,
  getOpenOrders,
  TOKEN_SYMBOLS_MAP,
  bnZero,
  BigNumber,
  forEachAsync,
  ConvertDecimals,
  EventSearchConfig,
  paginatedEventQuery,
  getBlockForTimestamp,
  getSpotClearinghouseState,
  getChainQuorum,
  getUserNonFundingLedgerUpdates,
  toBN,
  assert,
  getRedisCache,
  delay,
  toBNWei,
  fixedPointAdjustment,
  createFormatFunction,
  Block,
} from "../utils";
import { Log, SwapFlowInitialized } from "../interfaces";
import { CHAIN_MAX_BLOCK_LOOKBACK, CONTRACT_ADDRESSES } from "../common";
import { MultiCallerClient, EventListener, HubPoolClient } from "../clients";

export interface HyperliquidExecutorClients {
  // We can further constrain the HubPoolClient type since we don't call any functions on it.
  hubPoolClient: HubPoolClient;
  multiCallerClient: MultiCallerClient;
  dstProvider: Provider;
}

// Type describing the result of a task created by the HyperliquidExecutor.
// An actionable task resulted in a transaction being sent, while a non-actionable task
// is informational.
export type TaskResult = {
  actionable: boolean;
  mrkdwn: string;
};

// Minimal type describing a pair. Each pair has its own unique swap handler, but there may be
// pairs with the same name. E.g. a USDT0-USDC pair may have different swap handlers (depending on
// if the token the bot is trying to buy is USDC or USDT), but will have the same name (i.e. will use the
// same HL orderbook).
export type Pair = {
  name: string;
  swapHandler: EvmAddress;
  baseToken: EvmAddress;
  baseTokenId: number;
  baseTokenDecimals: number;
  finalToken: EvmAddress;
  finalTokenId: number;
  finalTokenDecimals: number;
};

const BASE_TOKENS = ["USDT0", "USDC"];
const abortController = new AbortController();

/**
 * Class which operates on HyperEVM handler contracts. This supports placing orders on Hypercore and transferring tokens from
 * swap handler contracts to users on Hypercore.
 */
export class HyperliquidExecutor {
  private dstOftMessenger: Contract;
  private dstCctpMessenger: Contract;
  private pairs: { [pair: string]: Pair } = {};
  private pairUpdates: { [pairName: string]: number } = {};
  private eventListener: EventListener;
  private infoClient;
  private redisClient;
  private handledEvents: Set<string> = new Set<string>();
  private dstSearchConfig: EventSearchConfig;

  private tasks: Promise<TaskResult>[] = [];
  private taskResolver;

  public initialized = false;
  private chainId = CHAIN_IDs.HYPEREVM;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: HyperliquidExecutorConfig,
    readonly clients: HyperliquidExecutorClients
  ) {
    // These must be defined.
    const signer = clients.hubPoolClient.hubPool.signer;
    this.dstOftMessenger = getDstOftHandler().connect(signer.connect(this.clients.dstProvider));
    this.dstCctpMessenger = getDstCctpHandler().connect(signer.connect(this.clients.dstProvider));

    this.infoClient = getHlInfoClient();
    this.eventListener = new EventListener(this.chainId, this.logger, getChainQuorum(this.chainId));
  }

  /*
   * @notice Initializes a HyperliquidExecutor or HyperliquidFinalizer instance
   * Hypercore token info is fetched dynamically by querying spotMeta on the Hyperliquid API
   */
  public async initialize(): Promise<void> {
    const spotMeta = await getSpotMeta(this.infoClient);
    this.redisClient = await getRedisCache(this.logger);
    // We must populate this.pairs with all token information.
    await forEachAsync(BASE_TOKENS, async (supportedToken) => {
      const counterpartTokens = this.config.supportedTokens.filter((token) => token !== supportedToken);
      await forEachAsync(counterpartTokens, async (counterpartToken) => {
        const baseToken = spotMeta.tokens.find((token) => token.name === supportedToken);
        const finalToken = spotMeta.tokens.find((token) => token.name === counterpartToken);
        // The token does not exist in the spot list, so no pair will exist.
        if (!isDefined(baseToken) || !isDefined(finalToken)) {
          return;
        }
        const pair = spotMeta.universe.find(
          (_pair) => _pair.tokens.includes(baseToken.index) && _pair.tokens.includes(finalToken.index)
        );
        if (!isDefined(pair)) {
          return;
        }
        // Ideally take token addresses from the spot meta, but if they do not exist, fallback to TOKEN_SYMBOLS_MAP.
        const baseTokenAddress =
          baseToken.evmContract?.address ?? TOKEN_SYMBOLS_MAP[baseToken.name].addresses[this.chainId];
        const finalTokenAddress =
          finalToken.evmContract?.address ?? TOKEN_SYMBOLS_MAP[finalToken.name].addresses[this.chainId];

        // There are only two available swap handlers.
        const dstHandler = baseToken.name === "USDT0" ? this.dstOftMessenger : this.dstCctpMessenger;
        const swapHandler = await dstHandler.predictSwapHandler(finalTokenAddress);

        const pairId = `${baseToken.name}-${finalToken.name}`;
        this.pairs[pairId] = {
          name: pair.name,
          swapHandler: EvmAddress.from(swapHandler),
          baseToken: EvmAddress.from(baseTokenAddress),
          baseTokenId: baseToken.index,
          baseTokenDecimals: baseToken.weiDecimals,
          finalToken: EvmAddress.from(finalTokenAddress),
          finalTokenId: finalToken.index,
          finalTokenDecimals: finalToken.weiDecimals,
        };
        this.pairUpdates[pairId] = 0;
      });
    });
    // Derive EventSearchConfig by using the configured lookback.
    const toBlock = await this.clients.dstProvider.getBlock("latest");
    const fromBlock = await getBlockForTimestamp(this.logger, this.chainId, toBlock.timestamp - this.config.lookback);
    this.dstSearchConfig = {
      to: toBlock.number,
      from: fromBlock,
      maxLookBack: CHAIN_MAX_BLOCK_LOOKBACK[this.chainId],
    };

    process.on("SIGHUP", () => {
      this.logger.debug({
        at: "HyperliquidExecutor#initialize",
        message: "Received SIGHUP on HyperliquidExecutor. stopping...",
      });
      abortController.abort();
    });

    process.on("disconnect", () => {
      this.logger.debug({
        at: "HyperliquidExecutor#initialize",
        message: "HyperliquidExecutor disconnected, stopping...",
      });
      abortController.abort();
    });
    this.initialized = true;
  }

  /*
   * @notice Main entrypoint for the HyperliquidFinalizer service
   * @dev The finalizer must derive accurate `limitOrderOuts` when finalizing swap flows on Hypercore. This is roughly done
   * by taking a snapshot block on HyperEVM, looking at the input/base token balance on Hypercore, and then determining how much
   * input tokens were swapped into the current output/final token balance on Hypercore. This gives us an average exchange rate up
   * to that block, which we use as the `limitOrderOut`.
   */
  public async finalizeSwapFlows(): Promise<void> {
    const snapshotBlock = await this.clients.dstProvider.getBlock("latest");

    // For each pair the finalizer handles, create a single transaction which bundles together all limit orders which have sufficient finalToken liquidity.
    await forEachAsync(Object.entries(this.pairs), async ([pairId, pair]) => {
      // There is a slight delay between the time a token is deposited to a spot balance on HyperEVM and the time a Hypercore balance is credited.
      // We _must_ find the exact timestamp in ms when the Hypercore account is credited if the snapshot block contains any action which would influence the
      // hypercore balance (i.e. any `SwapFlowInitialized` or `SwapFlowFinalized` event).
      const snapshotTimestampInMs = await this.getValidSnapshotTimestamp(pair, snapshotBlock);

      // PairIds are formatted as `BASE_TOKEN-FINAL_TOKEN`.
      const [baseTokenSymbol, finalTokenSymbol] = pairId.split("-");
      // We need to derive the "swappedInputTokenAmount", i.e. the amount of input tokens swapped in order for the handler its current amount of output tokens.
      const [inputSpotBalance, _outputSpotBalance, outstandingOrders] = await Promise.all([
        this.querySpotBalanceAtTimestamp(
          baseTokenSymbol,
          pair.swapHandler,
          pair.baseTokenDecimals,
          snapshotTimestampInMs
        ),
        this.querySpotBalanceAtTimestamp(
          finalTokenSymbol,
          pair.swapHandler,
          pair.finalTokenDecimals,
          snapshotTimestampInMs
        ),
        this.getOutstandingOrdersOnPair(pair, snapshotBlock.number),
      ]);
      let outputSpotBalance = _outputSpotBalance;
      // The swapped input amount is calculated by `totalInputBalance` - `currentInputBalance`, where `totalInputBalance` is the amount of input tokens that have been sent
      // into the contract which have no corresponding outflow. In other words, it's the sum of the input amounts of all currently outstanding crosschain mint/burn swaps.
      const { decimals: inputTokenDecimals } = this._getTokenInfo(pair.baseToken, this.chainId);
      const totalInputBalanceInRange = outstandingOrders.reduce((sum, order) => sum.add(order.evmAmountIn), bnZero);
      const totalInputBalanceInRangeCore = ConvertDecimals(
        inputTokenDecimals,
        pair.baseTokenDecimals
      )(totalInputBalanceInRange);
      const swappedInputAmount = totalInputBalanceInRangeCore.sub(inputSpotBalance);
      this.logger.debug({
        at: "HyperliquidExecutor#finalizeSwapFlows",
        message: "Snapshot data",
        snapshotBlock,
        inputSpotBalance,
        outputSpotBalance,
        totalInputBalanceInRangeCore,
        outstandingOrders: outstandingOrders.length,
      });

      // We must derive `limitOrderOuts` by finding the realized price of `outputToken` in terms of `inputToken`. This can be done by comparing how much input token we have swapped
      // with how much output token the contract owns.
      const quoteNonces = [];
      const outputAmounts = [];
      for (const outstandingOrder of outstandingOrders) {
        const convertedInputAmount = ConvertDecimals(
          inputTokenDecimals,
          pair.baseTokenDecimals
        )(outstandingOrder.evmAmountIn);
        // `limitOrderOut` is calculated using the realized price of _all_ orders over the time frame.
        const limitOrderOut = _outputSpotBalance.mul(convertedInputAmount).div(swappedInputAmount);
        // If for some reason this bot is deriving a limitOrderOut which deviates from the inputAmount by greater than a configured precision, then abort.
        // @dev This assumes that `limitOrderOut` and `convertedInputAmount` are denominated in the same decimals, which is true for all currently supported Hypercore stablecoins.
        const deviationPct = limitOrderOut
          .sub(convertedInputAmount)
          .mul(fixedPointAdjustment)
          .div(convertedInputAmount);
        const absDeviationPct = deviationPct.lt(bnZero) ? deviationPct.mul(-1) : deviationPct;
        if (absDeviationPct.gt(this.config.maxAllowedSlippage)) {
          const formatter = createFormatFunction(2, 4);
          this.logger.warn({
            at: "HyperliquidExecutor#finalizeSwapFlows",
            message: `Finalization amount is ${formatter(
              absDeviationPct
            )} greater than max allowed slippage ${formatter(deviationPct)}. Aborting finalizations.`,
            outstandingOrder,
            outstandingOrders: outstandingOrders.length,
          });
          break;
        }
        // If there is sufficient finalToken liquidity in the swap handler, then add it to the outstanding orders.
        if (limitOrderOut.lte(outputSpotBalance)) {
          quoteNonces.push(outstandingOrder.quoteNonce);
          outputAmounts.push(limitOrderOut);
          outputSpotBalance = outputSpotBalance.sub(limitOrderOut);
        } else {
          // Outstanding orders are treated as a FIFO queue. As soon as there is insufficient liquidity to fill one, do not attempt to fill any more recent orders.
          break;
        }
      }
      // If there are any orders to finalize, add them to the transaction queue.
      if (quoteNonces.length !== 0) {
        this.finalizeLimitOrders(pair.baseToken, pair.finalToken, quoteNonces, outputAmounts);
      }
    });
    await this.clients.multiCallerClient.executeTxnQueues();
  }

  /*
   * @notice Starts event listeners for the HyperliquidExecutor.
   * @dev The executor reacts to new blocks and new `SwapFlowInitialized` events. Upon an event/new block being observed, it pushes a new task to a queue.
   * Note that the task itself may be unactionable, but since determining whether there is something to do is async, it is left to the task processer, not the
   * event listener.
   */
  public startListeners(): void {
    // Handler for adding a new task based on a `SwapFlowInitialized` event.
    const handleSwapFlowInitiated = (log: Log) => {
      const swapFlowInitiated = log.args as SwapFlowInitialized;
      // If we handled the event already, then ignore it.
      if (this.handledEvents.has(swapFlowInitiated.quoteNonce)) {
        return;
      }
      this.handledEvents.add(swapFlowInitiated.quoteNonce);

      this.logger.debug({
        at: "HyperliquidExecutor#handleSwapFlowInitiated",
        message: "Observed new order event",
        swapFlowInitiated,
      });
      const baseToken = this.dstOftMessenger.address === log.address ? "USDT0" : "USDC";
      const finalToken = getTokenInfo(EvmAddress.from(swapFlowInitiated.finalToken), this.chainId).symbol;
      const pairId = `${baseToken}-${finalToken}`;
      const pair = this.pairs[pairId];

      // Update this pair. We submit a new order when a `SwapFlowInitalized` event happens, so we count it as a pair update.
      this.pairUpdates[pairId] = log.blockNumber;

      // Update tasks to place a new limit order.
      this.updateTasks(this.updateOrderAmount(pair));
    };

    // Handle `SwapFlowInitialized` events coming from all destination handlers.
    for (const handler of [this.dstOftMessenger, this.dstCctpMessenger]) {
      const eventDescriptor = handler.interface.getEvent("SwapFlowInitialized");
      const eventFormatted = eventDescriptor.format(ethersUtils.FormatTypes.full);
      this.eventListener.onEvent(handler.address, eventFormatted, handleSwapFlowInitiated);
    }

    // Handle new block events, constrained by a configured "review interval."
    const handleNewBlock = (blockNumber: number) => {
      Object.entries(this.pairUpdates).forEach(([pairId, updateBlock]) => {
        if (blockNumber - updateBlock < this.config.reviewInterval) {
          return;
        }
        this.logger.debug({
          at: "HyperliquidExecutor#handleNewBlock",
          message: "Reviewing active orders",
          lastReview: updateBlock,
          currentReviewBlock: blockNumber,
          pairId,
        });

        // Update tasks to refresh limit orders.
        this.updateTasks(this.updateOrderAmount(this.pairs[pairId]));
        this.pairUpdates[pairId] = blockNumber;
      });
    };
    // Start the block listener.
    this.eventListener.onBlock(handleNewBlock);
  }

  /*
   * @notice The main entrypoint for the HyperliquidExecutor.
   * The HyperliquidExecutor waits for tasks to be pushed to the task queue by the event listeners and evaluates them until the main process is aborted.
   */
  public async processTasks(): Promise<void> {
    // Blocking promise to wait for a task to be pushed to the task queue.
    for await (const taskResult of this.resolveNextTask()) {
      this.logger.debug({
        at: "HyperliquidExecutor#processTasks",
        message: "Finished processing task",
        taskResult,
      });
      if (this.clients.multiCallerClient.transactionCount() !== 0) {
        await this.clients.multiCallerClient.executeTxnQueues();
      }
    }
  }

  /*
   * @notice Utility function which tells the HyperliquidExecutor when a handoff has occurred.
   * Calls the abort controller and settles this function's promise once a handoff is observed.
   */
  public async waitForDisconnect(): Promise<void> {
    const {
      RUN_IDENTIFIER: runIdentifier,
      BOT_IDENTIFIER: botIdentifier,
      HL_MAX_CYCLES: _maxCycles = 120,
      HL_POLLING_DELAY: _pollingDelay = 3,
    } = process.env;
    const maxCycles = Number(_maxCycles);
    const pollingDelay = Number(_pollingDelay);
    // Set the active instance immediately on arrival here. This function will poll until it reaches the max amount of
    // runs or it is interrupted by another process.
    if (isDefined(runIdentifier) && isDefined(botIdentifier)) {
      await this.redisClient.set(botIdentifier, runIdentifier, maxCycles * pollingDelay);
      for (let run = 0; run < maxCycles; run++) {
        const currentBot = await this.redisClient.get(botIdentifier);
        if (currentBot !== runIdentifier) {
          this.logger.debug({
            at: "HyperliquidExecutor#waitForDisconnect",
            message: `Handing over ${runIdentifier} instance to ${currentBot} for ${botIdentifier}`,
            run,
          });
          abortController.abort();
          return;
        }
        await delay(pollingDelay);
      }
      // If we finish looping without receiving a handover signal, still exit so that we won't await the other promise forever.
      abortController.abort();
    }
  }

  /*
   * @notice Evaluates whether a new order should be placed on the input pair, and if so, enqueues a new transaction in the multicaller client.
   * @param pair Pair to evaluate.
   * @dev This function needs no knowledge on how much an order should be updated by, since at any point in time, the swap handler should try to swap
   * the entire input balance with the output balance.
   */
  private async updateOrderAmount(pair: Pair): Promise<TaskResult> {
    // Get the existing orders on the pair and the l2Book.
    const { symbol: baseTokenSymbol } = this._getTokenInfo(pair.baseToken, this.chainId);

    // The amount to swap to finalToken should always be the inputSpotBalance, since every swapHandler
    // must attempt to swap all inputToken amounts to `finalToken`s.
    const [openOrders, l2Book, sizeXe8] = await Promise.all([
      getOpenOrders(this.infoClient, { user: pair.swapHandler.toNative() }),
      getL2Book(this.infoClient, { coin: pair.name }),
      this.querySpotBalance(baseTokenSymbol, pair.swapHandler, pair.baseTokenDecimals),
    ]);
    const { baseToken, finalToken } = pair;

    // Set the price as the best ask.
    const existingOrder = openOrders[0];
    const bestAsk = Number(l2Book.levels[0][0].px);
    const priceXe8 = Math.floor(bestAsk * 10 ** pair.finalTokenDecimals);

    const oid = Math.floor(Date.now() / 1000); // Set the new order id to the current time in seconds.
    // Atomically replace the existing order with the new order by first cancelling the existing order and then placing a new one.
    if (isDefined(existingOrder)) {
      this.cancelLimitOrderByCloid(baseToken, finalToken, existingOrder.oid);
    } else if (sizeXe8.eq(bnZero)) {
      // If the inputSpotBalance is 0, then there is nothing to do.
      return { actionable: false, mrkdwn: "No order updates required" };
    }
    // Finally enqueue an order with the derived price and total swap handler's balance of baseToken.
    this.placeOrder(baseToken, finalToken, priceXe8, sizeXe8, oid);
    return { actionable: true, mrkdwn: `Placed new limit order at px: ${bestAsk} and sz: ${sizeXe8}.` };
  }

  // Onchain function wrappers.
  // Enqueues an order transaction in the multicaller client.
  private placeOrder(baseToken: EvmAddress, finalToken: EvmAddress, price: number, size: BigNumber, oid: number) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const finalTokenInfo = this._getTokenInfo(finalToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `baseToken: ${l2TokenInfo.symbol}\n finalToken: ${finalTokenInfo.symbol}\n price: ${price}\n size: ${size}\n oid: ${oid}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "submitLimitOrderFromBot",
      args: [finalToken.toNative(), price, size, oid],
      message: `Submitted limit order of ${l2TokenInfo.symbol} -> ${finalTokenInfo.symbol} to Hypercore.`,
      mrkdwn,
      nonMulticall: true, // Cannot multicall this since it is a permissioned action.
    });
  }

  /*
   * @notice Queries the spot balance of the input token symbol.
   * @param tokenSymbol Hyperliquid recognized token symbol (e.g. USDT0 for USDT).
   * @param owner The address whose balance should be queried.
   * @param decimals Hyperliquid obverved token decimals (as defined in the token meta).
   */
  private async querySpotBalance(tokenSymbol: string, owner: EvmAddress, decimals: number): Promise<BigNumber> {
    const { balances } = await getSpotClearinghouseState(this.infoClient, { user: owner.toNative() });
    const balance = balances.find((balance) => balance.coin === tokenSymbol);
    if (isDefined(balance)) {
      return toBN(Math.floor(Number(balance.total) * 10 ** decimals));
    }
    return bnZero;
  }

  /*
   * @notice Queries spot balance at a specific timestamp by taking the current balance and subtracting all spotSends which have occurred since.
   * @param tokenSymbol The token symbol to query.
   * @param owner The address whose balance should be queried.
   * @param decimals Hyperliquid obverved token decimals (as defined in the token meta).
   * @param timestampInMs The timestamp to query the snapshot balance, defined in milliseconds.
   */
  private async querySpotBalanceAtTimestamp(
    tokenSymbol: string,
    owner: EvmAddress,
    decimals: number,
    timestampInMs: number
  ): Promise<BigNumber> {
    // Query the current balance along with all ledger updates of the owner since the input timestamp.
    const [currentBalance, userNonFundingLedgerUpdates] = await Promise.all([
      this.querySpotBalance(tokenSymbol, owner, decimals),
      getUserNonFundingLedgerUpdates(this.infoClient, {
        user: owner.toNative(),
        startTime: timestampInMs,
      }),
    ]);
    // Out of scope transactions are spot sends to the owner which occurred since the input timestamp.
    const outOfScopeTransactions = userNonFundingLedgerUpdates.filter(
      ({ delta }) =>
        delta.type === "spotTransfer" &&
        delta.token === tokenSymbol &&
        delta.destination === owner.toNative().toLowerCase()
    );
    // Deduct all spot sends to the owner from the final amount.
    const outOfScopeBalance = outOfScopeTransactions.reduce((sum, txn) => {
      // Need to type check to ensure `amount` is a field of `txn.delta`.
      assert(txn.delta.type === "spotTransfer");
      const { amount } = txn.delta;
      return toBN(Math.floor(Number(amount) * 10 ** 8));
    }, bnZero);
    return currentBalance.sub(outOfScopeBalance);
  }

  /*
   * @notice Finds a precise snapshot timestamp for an input block.
   * @param snapshotBlock The block whose precise timestamp we need to find.
   */
  private async getValidSnapshotTimestamp(pair: Pair, snapshotBlock: Block): Promise<number> {
    const blockNumber = snapshotBlock.number;
    const baseTokenInfo = this._getTokenInfo(pair.baseToken, this.chainId);
    const associatedHandler = baseTokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    // We only need to check if this specific block has `SwapFlowInitialized` or `SwapFlowFinalized` events in it.
    // @dev Filtering on `pair.finalToken` should ensure that we only take events which correspond to the input pair,
    // since each recipient swap handler is uniquely identified by the baseToken (associatedHandler) and finalToken.
    const [initEvents, finalizeEvents] = await Promise.all([
      paginatedEventQuery(
        associatedHandler,
        associatedHandler.filters.SwapFlowInitialized(undefined, undefined, pair.finalToken.toNative()),
        { from: blockNumber, to: blockNumber, maxLookBack: 1 }
      ),
      paginatedEventQuery(
        associatedHandler,
        associatedHandler.filters.SwapFlowFinalized(undefined, undefined, pair.finalToken.toNative()),
        { from: blockNumber, to: blockNumber, maxLookBack: 1 }
      ),
    ]);
    let validTimestampMs = snapshotBlock.timestamp * 1000;

    // If either of these events exist in the snapshot block, then we need to take the latest snapshot timestamp of the two.
    // E.g. if both occurred and the account transferred USDC at t=100 and received at t=101, then the valid timestamp is t=101.
    // If only one is nonzero in length, then that transfer event timestamp is the valid timestamp.
    if (initEvents.length !== 0 || finalizeEvents.length !== 0) {
      // Only query spot transfers if we need to, i.e. if there is an event which occurred on the snapshot block.
      const spotTransfersFromHyperEvm = await getUserNonFundingLedgerUpdates(this.infoClient, {
        user: pair.swapHandler.toNative(),
        startTime: validTimestampMs,
        endTime: validTimestampMs + 750, // End time is hardcoded as 0.75s. This assumes that the core state update from HyperEVM will not take more than 0.75s after the timestamp of the HyperEVM block.
      });
      const finalTokenInfo = this._getTokenInfo(pair.finalToken, this.chainId);
      const initiatedAmounts = spotTransfersFromHyperEvm
        .filter(
          ({ delta }) =>
            delta.type === "spotTransfer" &&
            delta.token === baseTokenInfo.symbol &&
            delta.destination === pair.swapHandler.toNative().toLowerCase() &&
            delta.user === CONTRACT_ADDRESSES[this.chainId].hypercoreSpotSendAccount!.address
        )
        .map((transfer) => {
          validTimestampMs = validTimestampMs < transfer.time ? transfer.time : validTimestampMs;
          assert(transfer.delta.type === "spotTransfer");
          return toBNWei(transfer.delta.amount, pair.baseTokenDecimals).toString();
        });
      const finalizedAmounts = spotTransfersFromHyperEvm
        .filter(
          ({ delta }) =>
            delta.type === "spotTransfer" &&
            delta.token === finalTokenInfo.symbol &&
            delta.user === pair.swapHandler.toNative().toLowerCase()
        )
        .map((transfer) => {
          validTimestampMs = validTimestampMs < transfer.time ? transfer.time : validTimestampMs;
          assert(transfer.delta.type === "spotTransfer");
          return toBNWei(transfer.delta.amount, pair.finalTokenDecimals).toString();
        });

      // Go through all events and make sure all events are accounted for. Assert that we can find the associated core transfer.
      const filteredEvents = [];
      filteredEvents.push(
        ...initEvents.filter((initEvent) => {
          const eventAmount = initEvent.args.coreAmountIn;
          // Remove the first match. This handles scenarios where are collisions by amount.
          const index = initiatedAmounts.indexOf(eventAmount.toString());
          if (index > -1) {
            initiatedAmounts.splice(index, 1);
            return false;
          }
          return true;
        })
      );
      filteredEvents.push(
        ...finalizeEvents.filter((finalizeEvent) => {
          const amountSponsoredInCore = ConvertDecimals(
            finalTokenInfo.decimals,
            pair.finalTokenDecimals
          )(finalizeEvent.args.evmAmountSponsored);
          const eventAmount = finalizeEvent.args.totalSent.sub(amountSponsoredInCore); // In this case, the expected deduction in our account is the amount we do not sponsor.
          // Remove the first match. This handles scenarios where are collisions by amount.
          const index = finalizedAmounts.indexOf(eventAmount.toString());
          if (index > -1) {
            finalizedAmounts.splice(index, 1);
            return false;
          }
          return true;
        })
      );
      if (filteredEvents.length !== 0) {
        this.logger.error({
          at: "HyperliquidExecutor#getValidSnapshotTimestamp",
          message: "Detected HyperEVM event with no associated transfer event.",
          initEvents,
          finalizeEvents,
          spotTransfersFromHyperEvm,
        });
        throw new Error("Cannot continue with desynced balances");
      }
    }
    return validTimestampMs;
  }

  // Spot sends a token to the swap handler.
  private sendSponsorshipFundsToSwapHandler(baseToken: EvmAddress, amount: BigNumber) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `baseToken: ${l2TokenInfo.symbol}\n amount: ${amount}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "sendSponsorshipFundsToSwapHandler",
      args: [baseToken.toNative(), amount],
      message: "Sent sponsored funds to the swap handler.",
      mrkdwn,
      nonMulticall: true, // Cannot multicall this since it is a permissioned action.
      unpermissioned: false,
    });
  }

  // Cancels a limit order via the handler contract.
  private cancelLimitOrderByCloid(baseToken: EvmAddress, finalToken: EvmAddress, oid: number) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const finalTokenInfo = this._getTokenInfo(finalToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `baseToken: ${l2TokenInfo}\n finalToken: ${finalTokenInfo.symbol}\n oid: ${oid}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "cancelLimitOrderByCloid",
      args: [finalToken.toNative(), oid],
      message: `Cancelled limit order ${oid}.`,
      mrkdwn,
      nonMulticall: true, // Cannot multicall this since it is a permissioned action.
    });
  }

  /*
   * @notice Queries all outstanding orders on the destination handler contract corresponding to the input pair.
   * @param pair The baseToken -> finalToken pair whose outstanding orders are queried.
   * @param toBlock optional toBlock (defaults to "latest") to use when querying outstanding orders.
   */
  private async getOutstandingOrdersOnPair(pair: Pair, toBlock?: number): Promise<SwapFlowInitialized[]> {
    const l2TokenInfo = this._getTokenInfo(pair.baseToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;
    const searchConfig = { ...this.dstSearchConfig, to: toBlock ?? this.dstSearchConfig.to };
    const [orderInitializedEvents, orderFinalizedEvents] = await Promise.all([
      paginatedEventQuery(
        dstHandler,
        dstHandler.filters.SwapFlowInitialized(undefined, undefined, pair.finalToken.toNative()),
        searchConfig
      ),
      paginatedEventQuery(
        dstHandler,
        dstHandler.filters.SwapFlowFinalized(undefined, undefined, pair.finalToken.toNative()),
        searchConfig
      ),
    ]);
    return orderInitializedEvents
      .filter(
        (initEvent) => !orderFinalizedEvents.map(({ args }) => args.quoteNonce).includes(initEvent.args.quoteNonce)
      )
      .map(({ args }) => args as SwapFlowInitialized);
  }

  // Finalizes swap flows for the input quote nonces.
  private finalizeLimitOrders(
    baseToken: EvmAddress,
    finalToken: EvmAddress,
    quoteNonces: string[],
    limitOrderOutputs: BigNumber[]
  ) {
    // limitOrderOutputs is the amount of final tokens received for each limit order associated with a quoteNonce.
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `finalToken: ${l2TokenInfo.symbol}\n quoteNonces: ${quoteNonces}\n limitOrderOuts: ${limitOrderOutputs}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "finalizeSwapFlows",
      args: [finalToken.toNative(), quoteNonces, limitOrderOutputs],
      message: `Finalized ${quoteNonces.length} limit orders and sending output tokens to the user.`,
      mrkdwn,
      nonMulticall: true, // Cannot multicall this since it is a permissioned action.
    });
  }

  // Wrapper for `getTokenInfo` which changes `USDT` to `USDT0`.
  private _getTokenInfo(token: EvmAddress, chainId: number) {
    const tokenInfo = getTokenInfo(token, chainId);
    const updatedSymbol = tokenInfo.symbol === "USDT" ? "USDT0" : tokenInfo.symbol;
    return {
      ...tokenInfo,
      symbol: updatedSymbol,
    };
  }

  // Task utilities
  private async waitForNextTask(): Promise<void> {
    if (this.tasks.length > 0) {
      return;
    }
    await new Promise<void>((resolve) => (this.taskResolver = resolve));
  }

  // Async iterator which yields the top task in the task queue. If no task is present, then it waits for the task queue to receive
  // another task.
  private async *resolveNextTask() {
    while (!abortController.signal.aborted) {
      await this.waitForNextTask();

      // Yield the first task in the task queue.
      const topPromise = this.tasks.shift();
      const taskResult = await topPromise;

      yield taskResult;
    }
  }

  // Adds a task to the task queue and calls the task resolver (thereby waking the promise in `resolveNextTask`).
  private updateTasks(task: Promise<TaskResult>) {
    this.tasks.push(task);
    this.taskResolver();
  }
}
