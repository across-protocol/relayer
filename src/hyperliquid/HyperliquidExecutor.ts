import winston from "winston";
import { HyperliquidExecutorConfig } from "./HyperliquidExecutorConfig";
import {
  Contract,
  getRedisCache,
  Signer,
  Provider,
  isDefined,
  CHAIN_IDs,
  getTokenInfo,
  EvmAddress,
  BigNumber,
  getHlInfoClient,
  getSpotMeta,
  getOpenOrders,
  getDstOftHandler,
  getDstCctpHandler,
} from "../utils";
import { MultiCallerClient } from "../clients";
import { RedisCache } from "../caching/RedisCache";

export interface HyperliquidExecutorClients {
  // We can further constrain the HubPoolClient type since we don't call any functions on it.
  hubPoolClient: { hubPool: Contract; chainId: number };
  multiCallerClient: MultiCallerClient;
  dstProvider: Provider;
}

/**
 */
export class HyperliquidExecutor {
  private redisCache: RedisCache;
  private baseSigner: Signer;
  private dstOftMessenger: Contract;
  private dstCctpMessenger: Contract;
  private hlPairs: { [pair: string]: string } = {};
  private infoClient;

  public initialized = false;
  private chainId = CHAIN_IDs.HYPEREVM;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: HyperliquidExecutorConfig,
    readonly clients: HyperliquidExecutorClients
  ) {
    this.baseSigner = this.clients.hubPoolClient.hubPool.signer;

    // These must be defined.
    this.dstOftMessenger = getDstOftHandler().connect(this.clients.dstProvider);
    this.dstCctpMessenger = getDstCctpHandler().connect(this.clients.dstProvider);

    this.infoClient = getHlInfoClient();
  }

  public async initialize(): Promise<void> {
    this.redisCache = (await getRedisCache(this.logger)) as RedisCache;

    const spotMetas = await getSpotMeta(this.infoClient);
    this.config.supportedTokens.forEach((supportedToken) => {
      const counterpartTokens = this.config.supportedTokens.filter((token) => token !== supportedToken);
      counterpartTokens.forEach((counterpartToken) => {
        const tokenA = spotMetas.tokens.find((token) => token.name === supportedToken);
        const tokenB = spotMetas.tokens.find((token) => token.name === counterpartToken);
        if (!isDefined(tokenA) || !isDefined(tokenB)) {
          return;
        }
        const pair = spotMetas.universe.find(
          (_pair) => _pair.tokens.includes(tokenA.index) && _pair.tokens.includes(tokenB.index)
        );
        if (!isDefined(pair)) {
          return;
        }
        this.hlPairs[`${tokenA.name}-${tokenB.name}`] = pair.name;
      });
    });
    this.initialized = true;
  }

  public async shuffleOrders(): Promise<void> {
    const [outstandingUsdcOrders, outstandingUsdtOrders] = await Promise.all([
      getOpenOrders(this.infoClient, { user: this.dstCctpMessenger.address }),
      getOpenOrders(this.infoClient, { user: this.dstOftMessenger.address }),
    ]);
    this.logger.debug({
      at: "HyperliquidExecutor#shuffleOrders",
      message: "Outstanding orders",
      outstandingUsdcOrders,
      outstandingUsdtOrders,
    });
  }

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

  private async finalizeLimitOrders(finalToken: EvmAddress, quoteNonces: string[], minOutAmountsToSend: BigNumber[]) {
    // `minOutAmountsToSend` is the minimum amount of final tokens to send for each swap order. These are set in the
    // the SwapFlowInitialized events for each quoteNonce. If the actual amount received on the SwapHandler is 
    // less than this amount, then the HyperCoreFlowExecutor should sponsor that difference.
    const l2TokenInfo = this._getTokenInfo(finalToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `finalToken: ${l2TokenInfo.symbol}\n quoteNonces: ${quoteNonces}\n limitOrderOuts: ${minOutAmountsToSend}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "finalizeSwapFlows",
      args: [finalToken.toNative(), quoteNonces, minOutAmountsToSend],
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
}
