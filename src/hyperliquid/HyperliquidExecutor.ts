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
  toBN,
  getRedisCache,
  delay,
} from "../utils";
import { Log, SwapFlowInitialized } from "../interfaces";
import { CHAIN_MAX_BLOCK_LOOKBACK } from "../common";
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
  baseForFinal: boolean;
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
const HL_FIXED_ADJUSTMENT = 10 ** 8;
// There is a minimum order placement requirement of 10 USD.
const MIN_ORDER_AMOUNT = toBN(10 * HL_FIXED_ADJUSTMENT);

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

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

        // Save the direction of the pair: either base -> final or final -> base.
        const baseForFinal = pair.tokens[0] === baseToken.index;
        // Take the tokens from TOKEN_SYMBOLS_MAP, since the spot meta `evmContract` does not necessarily point to the ERC20 address.
        const castSymbol = (symbol: string) => (symbol === "USDT0" ? "USDT" : symbol);
        const baseTokenAddress = TOKEN_SYMBOLS_MAP[castSymbol(baseToken.name)].addresses[this.chainId];
        const finalTokenAddress = TOKEN_SYMBOLS_MAP[castSymbol(finalToken.name)].addresses[this.chainId];

        // There are only two available swap handlers.
        const dstHandler = baseToken.name === "USDT0" ? this.dstOftMessenger : this.dstCctpMessenger;
        const swapHandler = await dstHandler.predictSwapHandler(finalTokenAddress);

        const pairId = `${baseToken.name}-${finalToken.name}`;
        this.pairs[pairId] = {
          name: pair.name,
          baseForFinal,
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
   * @dev The finalizer gets `limitOrderOuts` by checking the current prices in the HL orderbook.
   */
  public async finalizeSwapFlows(toBlock?: number): Promise<void> {
    // For each pair the finalizer handles, create a single transaction which bundles together all limit orders which have sufficient finalToken liquidity.
    await forEachAsync(Object.entries(this.pairs), async ([pairId, pair]) => {
      const { decimals: inputTokenDecimals } = this._getTokenInfo(pair.baseToken, this.chainId);
      // PairIds are formatted as `BASE_TOKEN-FINAL_TOKEN`.
      const [, finalTokenSymbol] = pairId.split("-");
      // We need to derive the "swappedInputTokenAmount", i.e. the amount of input tokens swapped in order for the handler its current amount of output tokens.
      const [_outputSpotBalance, outstandingOrders, l2Book] = await Promise.all([
        this.querySpotBalance(finalTokenSymbol, pair.swapHandler, pair.finalTokenDecimals),
        this.getOutstandingOrdersOnPair(pair, toBlock),
        getL2Book(this.infoClient, { coin: pair.name }),
      ]);
      let outputSpotBalance = _outputSpotBalance;
      const currentPx = pair.baseForFinal ? l2Book.levels[0][0].px : l2Book.levels[1][0].px;
      const currentPxFixed = toBN(Math.floor(Number(currentPx) * HL_FIXED_ADJUSTMENT));

      // limitOrderOut is taken from current prices.
      // Fill orders FIFO.
      const quoteNonces = [];
      const outputAmounts = [];
      for (const outstandingOrder of outstandingOrders) {
        const convertedInputAmount = ConvertDecimals(
          inputTokenDecimals,
          pair.baseTokenDecimals
        )(outstandingOrder.evmAmountIn);
        // LimitOrderOut = inputAmount * exchangeRate.
        const _limitOrderOut = convertedInputAmount.mul(currentPxFixed).div(HL_FIXED_ADJUSTMENT);
        const limitOrderOut = _limitOrderOut.gt(outstandingOrder.maxAmountToSend)
          ? outstandingOrder.maxAmountToSend
          : _limitOrderOut;
        // If there is sufficient finalToken liquidity in the swap handler, then add it to the outstanding orders.
        if (limitOrderOut.lte(outputSpotBalance)) {
          quoteNonces.push(outstandingOrder.quoteNonce);
          outputAmounts.push(limitOrderOut);
          outputSpotBalance = outputSpotBalance.sub(limitOrderOut);
        } else {
          // Outstanding orders are treated as a FIFO queue. As soon as there is insufficient liquidity to fill one, do not attempt to fill any more recent orders.
          this.logger.debug({
            at: "HyperliquidExecutor#finalizeSwapFlows",
            message: "Cannot finalize any more orders",
            amountToFinalize: quoteNonces.length,
            remainingAmount: outstandingOrders.length - quoteNonces.length,
            pairId,
            outputSpotBalance,
            nextOrderUp: outstandingOrder,
            amountNeededToCover: limitOrderOut.sub(outputSpotBalance),
          });
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
    const [openOrders, l2Book, _sizeXe8] = await Promise.all([
      getOpenOrders(this.infoClient, { user: pair.swapHandler.toNative() }),
      getL2Book(this.infoClient, { coin: pair.name }),
      this.querySpotBalance(baseTokenSymbol, pair.swapHandler, pair.baseTokenDecimals),
    ]);
    const sizeXe8 = this.roundSize(_sizeXe8);
    const { baseToken, finalToken } = pair;

    // Set the price as the best ask.
    const existingOrder = openOrders[0];
    const level = pair.baseForFinal ? 0 : 1;
    const bestAsk = Number(l2Book.levels[level][0].px);
    const priceXe8 = Math.floor(bestAsk * 10 ** pair.finalTokenDecimals);
    // No need to update prices.

    const oid = Math.floor(Date.now() / 1000); // Set the new order id to the current time in seconds.
    // Atomically replace the existing order with the new order by first cancelling the existing order and then placing a new one.
    if (isDefined(existingOrder)) {
      this.cancelLimitOrderByCloid(baseToken, finalToken, BigNumber.from(existingOrder.cloid));
    }
    // Only place an order if it is greater than the minimum.
    if (sizeXe8.lt(MIN_ORDER_AMOUNT)) {
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

    const mrkdwn = `\nbaseToken: ${l2TokenInfo.symbol}\n finalToken: ${finalTokenInfo.symbol}\n price: ${price}\n size: ${size}\n oid: ${oid}`;
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

  // Spot sends a token to the swap handler.
  private sendSponsorshipFundsToSwapHandler(baseToken: EvmAddress, amount: BigNumber) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `\nbaseToken: ${l2TokenInfo.symbol}\n amount: ${amount}`;
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
  private cancelLimitOrderByCloid(baseToken: EvmAddress, finalToken: EvmAddress, oid: BigNumber) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const finalTokenInfo = this._getTokenInfo(finalToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `\nbaseToken: ${l2TokenInfo.symbol}\n finalToken: ${finalTokenInfo.symbol}\n oid: ${oid}`;
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
  private async getOutstandingOrdersOnPair(pair: Pair, to = this.dstSearchConfig.to): Promise<SwapFlowInitialized[]> {
    const l2TokenInfo = this._getTokenInfo(pair.baseToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;
    const searchConfig = { ...this.dstSearchConfig, to };
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
    const finalTokenInfo = this._getTokenInfo(finalToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `\nbaseToken: ${l2TokenInfo.symbol}\n finalToken: ${finalTokenInfo.symbol}\n quoteNonces: ${quoteNonces}\n limitOrderOuts: ${limitOrderOutputs}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "finalizeSwapFlows",
      args: [finalToken.toNative(), quoteNonces, limitOrderOutputs],
      message: `Finalized ${quoteNonces.length} limit orders.`,
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

  // Rounds an input size to two "decimals" of precision (that is, XX.XXXX USDC -> XX.XX USDC).
  private roundSize(sizeXe8: BigNumber): BigNumber {
    const roundAmount = 10 ** 6; // 8-2 decimals to use when rounding.
    return sizeXe8.div(roundAmount).mul(roundAmount);
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
