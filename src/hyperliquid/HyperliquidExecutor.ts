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
  swapHandler: EvmAddress;
  baseToken: EvmAddress;
  baseTokenId: number;
  finalToken: EvmAddress;
  finalTokenId: number;
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

  public async initialize(): Promise<void> {
    const spotMeta = await getSpotMeta(this.infoClient);
    this.redisClient = await getRedisCache(this.logger);
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
        const baseTokenAddress =
          baseToken.evmContract?.address ?? TOKEN_SYMBOLS_MAP[baseToken.name].addresses[this.chainId];
        const finalTokenAddress =
          finalToken.evmContract?.address ?? TOKEN_SYMBOLS_MAP[finalToken.name].addresses[this.chainId];

        const dstHandler = baseToken.name === "USDT0" ? this.dstOftMessenger : this.dstCctpMessenger;
        const swapHandler = await dstHandler.predictSwapHandler(finalTokenAddress);

        const pairId = `${baseToken.name}-${finalToken.name}`;
        this.pairs[pairId] = {
          name: pair.name,
          swapHandler: EvmAddress.from(swapHandler),
          baseToken: EvmAddress.from(baseTokenAddress),
          baseTokenId: baseToken.index,
          finalToken: EvmAddress.from(finalTokenAddress),
          finalTokenId: finalToken.index,
        };
        this.pairUpdates[pairId] = 0;
      });
    });
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

  public async finalizeSwapFlows(): Promise<void> {
    const snapshotBlock = await this.clients.dstProvider.getBlock("latest");
    const currentTimeInMs = snapshotBlock.timestamp * 1000;
    await forEachAsync(Object.entries(this.pairs), async ([pairId, pair]) => {
      const [baseTokenSymbol, finalTokenSymbol] = pairId.split("-");
      const [inputSpotBalance, _outputSpotBalance, outstandingOrders] = await Promise.all([
        this.querySpotBalanceAtTimestamp(baseTokenSymbol, pair.swapHandler, currentTimeInMs),
        this.querySpotBalanceAtTimestamp(finalTokenSymbol, pair.swapHandler, currentTimeInMs),
        this.getOutstandingOrdersOnPair(pair, snapshotBlock.number),
      ]);
      let outputSpotBalance = _outputSpotBalance;
      const { decimals: inputTokenDecimals } = this._getTokenInfo(pair.baseToken, this.chainId);
      const totalInputBalanceInRange = outstandingOrders.reduce((sum, order) => sum.add(order.evmAmountIn), bnZero);
      const totalInputBalanceInRangeCore = ConvertDecimals(inputTokenDecimals, 8)(totalInputBalanceInRange);
      const swappedInputAmount = totalInputBalanceInRangeCore.sub(inputSpotBalance);

      const quoteNonces = [];
      const outputAmounts = [];
      outstandingOrders.forEach((outstandingOrder) => {
        const convertedInputAmount = ConvertDecimals(inputTokenDecimals, 8)(outstandingOrder.evmAmountIn);
        const limitOrderOut = outputSpotBalance.mul(convertedInputAmount).div(swappedInputAmount);
        if (limitOrderOut.lte(outputSpotBalance)) {
          quoteNonces.push(outstandingOrder.quoteNonce);
          outputAmounts.push(limitOrderOut);
          outputSpotBalance = outputSpotBalance.sub(limitOrderOut);
        }
      });
      if (quoteNonces.length !== 0) {
        this.finalizeLimitOrders(pair.baseToken, pair.finalToken, quoteNonces, outputAmounts);
      }
    });
    await this.clients.multiCallerClient.executeTxnQueues();
  }

  public startListeners(): void {
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

      this.pairUpdates[pairId] = log.blockNumber;

      // Update tasks to place a new limit order.
      this.updateTasks(this.updateOrderAmount(pair));
    };

    // Handle events coming from all destination handlers.
    for (const handler of [this.dstOftMessenger, this.dstCctpMessenger]) {
      const eventDescriptor = handler.interface.getEvent("SwapFlowInitialized");
      const eventFormatted = eventDescriptor.format(ethersUtils.FormatTypes.full);
      this.eventListener.onEvent(handler.address, eventFormatted, handleSwapFlowInitiated);
    }

    // Handle new block events.
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
    this.eventListener.onBlock(handleNewBlock);
  }

  public async processTasks(): Promise<void> {
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
    }
  }

  private async updateOrderAmount(pair: Pair): Promise<TaskResult> {
    // Get the existing orders on the pair and the l2Book.
    const { symbol: baseTokenSymbol } = this._getTokenInfo(pair.baseToken, this.chainId);

    // The amount to swap to finalToken should always be the inputSpotBalance, since every swapHandler
    // must attempt to swap all inputToken amounts to `finalToken`s.
    const [openOrders, l2Book, sizeXe8] = await Promise.all([
      getOpenOrders(this.infoClient, { user: pair.swapHandler.toNative() }),
      getL2Book(this.infoClient, { coin: pair.name }),
      this.querySpotBalance(baseTokenSymbol, pair.swapHandler),
    ]);
    const { baseToken, finalToken } = pair;

    // Set the price as the best ask.
    const existingOrder = openOrders[0];
    const bestAsk = Number(l2Book.levels[0][0].px);
    const priceXe8 = Math.floor(bestAsk * 10 ** 8);

    const oid = Math.floor(Date.now() / 1000); // Set the new order id to the current time in seconds.
    // Atomically replace the existing order with the new order by first cancelling the existing order and then placing a new one.
    if (isDefined(existingOrder)) {
      this.cancelLimitOrderByCloid(baseToken, finalToken, existingOrder.oid);
    } else if (sizeXe8.eq(bnZero)) {
      // If the inputSpotBalance is 0, then there is nothing to do.
      return { actionable: false, mrkdwn: "No order updates required" };
    }
    this.placeOrder(baseToken, finalToken, priceXe8, sizeXe8, oid);
    return { actionable: true, mrkdwn: `Placed new limit order at px: ${bestAsk} and sz: ${sizeXe8}.` };
  }

  // Onchain function wrappers.
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

  private async querySpotBalance(tokenSymbol: string, owner: EvmAddress): Promise<BigNumber> {
    const { balances } = await getSpotClearinghouseState(this.infoClient, { user: owner.toNative() });
    const balance = balances.find((balance) => balance.coin === tokenSymbol);
    if (isDefined(balance)) {
      return toBN(Math.floor(Number(balance.total) * 10 ** 8));
    }
    return bnZero;
  }

  private async querySpotBalanceAtTimestamp(
    tokenSymbol: string,
    owner: EvmAddress,
    timestampInMs: number
  ): Promise<BigNumber> {
    const [currentBalance, userNonFundingLedgerUpdates] = await Promise.all([
      this.querySpotBalance(tokenSymbol, owner),
      getUserNonFundingLedgerUpdates(this.infoClient, {
        user: owner.toNative(),
        startTime: timestampInMs,
      }),
    ]);
    const outOfScopeTransactions = userNonFundingLedgerUpdates.filter(
      ({ delta }) =>
        delta.type === "spotTransfer" &&
        delta.token === tokenSymbol &&
        delta.destination === owner.toNative().toLowerCase()
    );
    const outOfScopeBalance = outOfScopeTransactions.reduce((sum, txn) => {
      // Need to type check to ensure `amount` is a field of `txn.delta`.
      assert(txn.delta.type === "spotTransfer");
      const { amount } = txn.delta;
      return toBN(Math.floor(Number(amount) * 10 ** 8));
    }, bnZero);
    return currentBalance.sub(outOfScopeBalance);
  }

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

  private async *resolveNextTask() {
    while (!abortController.signal.aborted) {
      await this.waitForNextTask();

      // Yield the first task in the task queue.
      const topPromise = this.tasks.shift();
      const taskResult = await topPromise;

      yield taskResult;
    }
  }

  private updateTasks(task: Promise<TaskResult>) {
    this.tasks.push(task);
    this.taskResolver();
  }
}
