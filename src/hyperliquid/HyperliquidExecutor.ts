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
  BigNumber,
  getHlInfoClient,
  getSpotMeta,
  getDstOftHandler,
  getL2Book,
  getDstCctpHandler,
  spreadEventWithBlockNumber,
  getOpenOrders,
} from "../utils";
import { Log, SwapFlowInitialized } from "../interfaces";
import { MultiCallerClient, EventListener } from "../clients";

export interface HyperliquidExecutorClients {
  // We can further constrain the HubPoolClient type since we don't call any functions on it.
  hubPoolClient: { hubPool: Contract; chainId: number };
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
    this.dstOftMessenger = getDstOftHandler().connect(this.clients.dstProvider);
    this.dstCctpMessenger = getDstCctpHandler().connect(this.clients.dstProvider);

    this.infoClient = getHlInfoClient();
    this.eventListener = new EventListener(CHAIN_IDs.HYPEREVM, this.logger, 1);
  }

  public async initialize(): Promise<void> {
    const spotMeta = await getSpotMeta(this.infoClient);
    this.config.supportedTokens.forEach((supportedToken) => {
      const counterpartTokens = this.config.supportedTokens.filter((token) => token !== supportedToken);
      counterpartTokens.forEach((counterpartToken) => {
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
        const swapHandler = baseToken.name === "USDT0" ? this.dstOftMessenger.address : this.dstCctpMessenger.address; // @todo
        this.pairs[`${baseToken.name}-${finalToken.name}`] = {
          name: pair.name,
          swapHandler: EvmAddress.from(swapHandler),
        };
        this.pairUpdates[pair.name] = 0;
      });
    });
    this.initialized = true;
  }

  public startListeners(): void {
    const handleSwapFlowInitiated = (log: Log) => {
      const swapFlowInitiated = spreadEventWithBlockNumber(log) as SwapFlowInitialized;
      this.logger.debug({
        at: "HyperliquidExecutor#handleSwapFlowInitiated",
        message: "Observed new order event",
        swapFlowInitiated,
      });
      const baseToken = this.dstOftMessenger.address === log.address ? "USDT0" : "USDC";
      const finalToken = getTokenInfo(EvmAddress.from(swapFlowInitiated.finalToken), this.chainId).symbol;
      const pair = this.pairs[`${baseToken}-${finalToken}`];

      this.pairUpdates[pair.name] = log.blockNumber;

      // Update tasks to place a new limit order.
      this.updateTasks(this.placeNewOrderOnPair(pair, swapFlowInitiated));
    };

    // Handle events coming from all destination handlers.
    for (const handler of [this.dstOftMessenger, this.dstCctpMessenger]) {
      const eventDescriptor = handler.interface.getEvent("SwapFlowInitialized");
      const eventFormatted = eventDescriptor.format(ethersUtils.FormatTypes.full);
      this.eventListener.onEvent(handler.address, eventFormatted, handleSwapFlowInitiated);
    }

    // Handle new block events.
    const handleNewBlock = (blockNumber: number) => {
      Object.entries(this.pairUpdates).forEach(([pair, updateBlock]) => {
        if (blockNumber - updateBlock < this.reviewInterval) {
          return;
        }
        this.logger.debug({
          at: "HyperliquidExecutor#handleNewBlock",
          message: "Reviewing active orders",
          lastReview: updateBlock,
          currentReviewBlock: blockNumber,
          pair,
        });

        // Update tasks to refresh limit orders.
        this.updateTasks(this.refreshOrdersOnPair(pair));
        this.pairUpdates[pair] = blockNumber;
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
    }
  }

  public deactivate() {
    this.active = false;
  }

  private async placeNewOrderOnPair(pair: Pair, swapInitiatedEvent: SwapFlowInitialized): Promise<TaskResult> {
    // Get the existing orders on the pair and the l2Book.
    const [openOrders, l2Book] = await Promise.all([
      getOpenOrders(this.infoClient, { user: pair.swapHandler.toNative() }),
      getL2Book(this.infoClient, { coin: pair.name }),
    ]);

    // Calculate the amount to place.
    swapInitiatedEvent;
    // @todo
    return { actionable: true, mrkdwn: "UNIMPLEMENTED" };
  }

  private async refreshOrdersOnPair(pairName: string): Promise<TaskResult> {
    const pair = Object.values(this.pairs).find((_pair) => _pair.name === pairName);

    // Check open orders for the swap handler and the current state of the orderbook.
    const [openOrders, l2Book] = await Promise.all([
      getOpenOrders(this.infoClient, { user: pair.swapHandler.toNative() }),
      getL2Book(this.infoClient, { coin: pair.name }),
    ]);

    // If we do not need to replace an order since the order on the book is still at the ask level, then there
    // is nothing actionable for this update.
    const bestAsk = l2Book.levels[1][0]; // Best ask is the first element in the ask array.
    if (openOrders.length === 0 || openOrders.every((order) => order.limitPx === bestAsk.px)) {
      return {
        actionable: false,
        mrkdwn: `Nothing to do: total open orders: ${openOrders.length}, current best ask: ${bestAsk}`,
      };
    }

    // Otherwise, we need to replace the existing order with a new order at the current ask price.
    // @todo
    return { actionable: true, mrkdwn: "UNIMPLEMENTED" };
  }

  // Onchain function wrappers.
  private async placeOrder(
    baseToken: EvmAddress,
    finalToken: EvmAddress,
    price: number,
    size: number,
    cloid: BigNumber
  ) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const finalTokenInfo = this._getTokenInfo(finalToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `baseToken: ${l2TokenInfo.symbol}\n finalToken: ${finalTokenInfo.symbol}\n price: ${price}\n size: ${size}\n cloid: ${cloid}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "submitLimitOrderFromBot",
      args: [finalToken.toNative(), price, size, cloid],
      message: `Submitted limit order of ${l2TokenInfo.symbol} -> ${finalTokenInfo.symbol} to Hypercore.`,
      mrkdwn,
      nonMulticall: true, // Cannot multicall this since it is a permissioned action.
    });
  }

  private async sendSponsorshipFundsToSwapHandler(baseToken: EvmAddress, amount: BigNumber) {
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
    });
  }

  private async cancelLimitOrderByCloid(baseToken: EvmAddress, finalToken: EvmAddress, cloid: BigNumber) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const finalTokenInfo = this._getTokenInfo(finalToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `baseToken: ${l2TokenInfo}\n finalToken: ${finalTokenInfo.symbol}\n cloid: ${cloid}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "cancelLimitOrderByCloid",
      args: [finalToken.toNative(), cloid],
      message: `Cancelled limit order ${cloid}.`,
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

  private _sortTokenSymbols(_tokenA: string, _tokenB: string): [string, string] {
    return _tokenA > _tokenB ? [_tokenA, _tokenB] : [_tokenB, _tokenA];
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
