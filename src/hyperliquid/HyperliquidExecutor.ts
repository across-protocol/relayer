import winston from "winston";
import { HyperliquidBotConfig } from "./HyperliquidBotConfig";
import { HyperliquidBase, HyperliquidBaseClients } from "./HyperliquidBase";
import { getRedisCache, isDefined, getSpotMeta, getOpenOrders } from "../utils";
import { RedisCache } from "../caching/RedisCache";

/**
 */
export class HyperliquidExecutor extends HyperliquidBase {
  private hlPairs: { [pair: string]: string } = {};

  public constructor(
    readonly logger: winston.Logger,
    readonly config: HyperliquidBotConfig,
    readonly clients: HyperliquidBaseClients
  ) {
    super(logger, config, clients);
  }

  public override async initialize(): Promise<void> {
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
    await super.initialize();
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
}
