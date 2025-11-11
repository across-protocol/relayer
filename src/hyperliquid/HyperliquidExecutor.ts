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
} from "../utils";
import { Log, SwapFlowInitialized } from "../interfaces";
import { CONTRACT_ADDRESSES, CHAIN_MAX_BLOCK_LOOKBACK } from "../common";
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
  private handledEvents: Set<string> = new Set<string>();
  private dstSearchConfig: EventSearchConfig;

  private tasks: Promise<TaskResult>[] = [];
  private taskResolver;

  public initialized = false;
  public active = true;
  private reviewInterval = 10;
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
    this.eventListener = new EventListener(CHAIN_IDs.HYPEREVM, this.logger, 1);
  }

  public async initialize(): Promise<void> {
    const spotMeta = await getSpotMeta(this.infoClient);
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
    this.initialized = true;
  }

  public async finalizeSwapFlows(): Promise<void> {
    await forEachAsync(Object.entries(this.pairs), async ([pairId, pair]) => {
      const [baseTokenSymbol, finalTokenSymbol] = pairId.split("-");
      const [inputSpotBalance, _outputSpotBalance, outstandingOrders] = await Promise.all([
        this.querySpotBalance(baseTokenSymbol, pair.swapHandler),
        this.querySpotBalance(finalTokenSymbol, pair.swapHandler),
        this.getOutstandingOrdersOnPair(pair),
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
      this.updateTasks(this.updateOrderAmount(pair, BigNumber.from(swapFlowInitiated.evmAmountIn)));
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
        if (blockNumber - updateBlock < this.reviewInterval) {
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
        this.updateTasks(this.updateOrderAmount(this.pairs[pairId], bnZero)); // Placing an order with an order amount of zero just refreshes the order at the bestAsk.
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

  public deactivate() {
    this.active = false;
  }

  private async updateOrderAmount(pair: Pair, orderAmount: BigNumber): Promise<TaskResult> {
    // Get the existing orders on the pair and the l2Book.
    const [openOrders, l2Book] = await Promise.all([
      getOpenOrders(this.infoClient, { user: pair.swapHandler.toNative() }),
      getL2Book(this.infoClient, { coin: pair.name }),
    ]);
    const { baseToken, finalToken } = pair;
    const { decimals } = this._getTokenInfo(baseToken, this.chainId);

    const existingOrder = openOrders[0];
    const bestAsk = Number(l2Book.levels[0][0].px);
    const priceXe8 = Math.floor(bestAsk * 10 ** 8);
    // The swap handler should only have orders placed on the associated pair.
    // `sz` represents the remaining, unfilled quantity.
    const existingAmountPlaced = BigNumber.from(openOrders[0]?.sz ?? 0);
    const existingAmountPlacedQuantums = existingAmountPlaced.mul(10 ** decimals);
    const newAmountToPlace = orderAmount.add(existingAmountPlacedQuantums);
    const sizeXe8 = ConvertDecimals(decimals, 8)(newAmountToPlace);

    const oid = Math.floor(Date.now() / 1000); // Set the new order id to the current time in seconds.
    // Atomically replace the existing order with the new order by first cancelling the existing order and then placing a new one.
    if (isDefined(existingOrder)) {
      this.cancelLimitOrderByCloid(baseToken, finalToken, existingOrder.oid);
    } else if (newAmountToPlace.eq(bnZero)) {
      // If the existing order is undefined and there is no new amount to place, then there is nothing actionable for us to do on this update.
      return { actionable: false, mrkdwn: "No order updates required" };
    }
    this.placeOrder(baseToken, finalToken, priceXe8, sizeXe8, oid);
    return { actionable: true, mrkdwn: `Placed new limit order at px: ${bestAsk} and sz: ${newAmountToPlace}.` };
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
      unpermissioned: false,
    });
  }

  private async querySpotBalance(tokenSymbol: string, owner: EvmAddress): Promise<BigNumber> {
    const { balances } = await getSpotClearinghouseState(this.infoClient, { user: owner.toNative() });
    const balance = balances.find((balance) => balance.coin === tokenSymbol);
    if (isDefined(balance)) {
      return BigNumber.from(Math.floor(Number(balance.total) * 10 ** 8));
    }
    return bnZero;
  }

  private async querySpotBalanceFromEvm(hyperEvmTokenId: number, owner: EvmAddress): Promise<BigNumber> {
    const { address: coreReader } = CONTRACT_ADDRESSES[CHAIN_IDs.HYPEREVM].coreReader;
    const rawCalldata = ethersUtils.defaultAbiCoder.encode(["address", "uint256"], [owner.toNative(), hyperEvmTokenId]);

    const rawDataCall = await this.clients.dstProvider.call({
      to: coreReader,
      data: rawCalldata,
    });
    return BigNumber.from(`0x${rawDataCall.slice(-64)}`);
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

  private async getOutstandingOrdersOnPair(pair: Pair): Promise<SwapFlowInitialized[]> {
    const l2TokenInfo = this._getTokenInfo(pair.baseToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;
    const [orderInitializedEvents, orderFinalizedEvents] = await Promise.all([
      paginatedEventQuery(
        dstHandler,
        dstHandler.filters.SwapFlowInitialized(undefined, undefined, pair.finalToken.toNative()),
        this.dstSearchConfig
      ),
      paginatedEventQuery(
        dstHandler,
        dstHandler.filters.SwapFlowFinalized(undefined, undefined, pair.finalToken.toNative()),
        this.dstSearchConfig
      ),
    ]);
    return orderInitializedEvents
      .filter(
        (initEvent) => !orderFinalizedEvents.map(({ args }) => args.quoteNonce).includes(initEvent.args.quoteNonce)
      )
      .map(({ args }) => args as SwapFlowInitialized);
  }

  private _getTokenInfo(token: EvmAddress, chainId: number) {
    let tokenInfo;
    try {
      tokenInfo = getTokenInfo(token, chainId);
    } catch {
      tokenInfo = {
        symbol: "UNKNOWN",
        decimals: 8,
      };
    }
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
    while (this.active) {
      await this.waitForNextTask();

      // Yield the first task to complete in the array of tasks and remove that promise from the list of outstanding tasks.
      const taskResult = Promise.race(this.tasks);
      this.tasks.splice(this.tasks.indexOf(Promise.resolve(taskResult)), 1);

      yield taskResult;
    }
  }

  private updateTasks(task: Promise<TaskResult>) {
    this.tasks.push(task);
    this.taskResolver();
  }
}
