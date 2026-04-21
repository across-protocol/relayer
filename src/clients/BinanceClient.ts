import Binance, { HttpMethod, type Binance as BinanceApi } from "binance-api-node";
import minimist from "minimist";
import { create, number, type } from "superstruct";
import winston from "winston";
import { hasBinanceRoute } from "../common";
import {
  acrossApi,
  Address,
  assert,
  BigNumber,
  bnZero,
  coingecko,
  defiLlama,
  EvmAddress,
  getGckmsConfig,
  isDefined,
  PriceClient,
  retrieveGckmsKeys,
  toBNWei,
} from "../utils";
import { getAcrossHost } from "./AcrossAPIClient";
import type { WithdrawalQuota } from "../utils/BinanceUtils";

export type { WithdrawalQuota };

// `type()` over `object()` to tolerate additional fields Binance may add later.
const WithdrawalQuotaSS = type({
  wdQuota: number(),
  usedWdQuota: number(),
});

export type BinanceClientOptions = {
  logger: winston.Logger;
  hubChainId: number;
  url?: string;
};

export class BinanceClient {
  private static binanceSecretKeyPromise: Promise<string | undefined> | undefined = undefined;

  // Undefined before first refresh and after any failure — treated as "no capacity".
  private remainingQuotaUsd: BigNumber | undefined;
  private l1TokenPricesUsd: Map<string, BigNumber> = new Map();

  private constructor(
    private readonly api: BinanceApi,
    private readonly priceClient: PriceClient,
    private readonly logger: winston.Logger
  ) {}

  static async create(options: BinanceClientOptions): Promise<BinanceClient> {
    const { logger, hubChainId, url = "https://api.binance.com" } = options;
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = (await BinanceClient.getBinanceSecretKey()) ?? process.env.BINANCE_HMAC_KEY;
    assert(isDefined(apiKey) && isDefined(secretKey), "Binance client cannot be constructed due to missing keys.");

    const priceClient = new PriceClient(logger, [
      new acrossApi.PriceFeed({ host: getAcrossHost(hubChainId) }),
      new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
      new defiLlama.PriceFeed(),
    ]);

    return new BinanceClient(Binance({ apiKey, apiSecret: secretKey, httpBase: url }), priceClient, logger);
  }

  rawApi(): BinanceApi {
    return this.api;
  }

  async getWithdrawalLimits(): Promise<WithdrawalQuota> {
    const raw = await this.api.privateRequest("GET" as HttpMethod, "/sapi/v1/capital/withdraw/quota", {});
    return create(raw, WithdrawalQuotaSS);
  }

  // Strict-fail: any error wipes both caches, leaving capacity checks false until the next refresh.
  async refresh(l1Tokens: EvmAddress[], enabledChains: number[]): Promise<void> {
    this.remainingQuotaUsd = undefined;
    this.l1TokenPricesUsd.clear();

    const binanceRouteTokens = l1Tokens.filter((l1Token) =>
      enabledChains.some((chainId) => hasBinanceRoute(chainId, l1Token))
    );
    if (binanceRouteTokens.length === 0) {
      return;
    }

    try {
      const quota = await this.getWithdrawalLimits();
      const tokenPrices = await this.priceClient.getPricesByAddress(
        binanceRouteTokens.map((l1Token) => l1Token.toNative()),
        "usd"
      );
      const refreshedPrices = new Map<string, BigNumber>();
      tokenPrices.forEach(({ address, price }) => {
        if (price > 0) {
          refreshedPrices.set(address, toBNWei(price.toFixed(18)));
        }
      });
      // Assign only after both fetches succeed, so a partial refresh can't be observed.
      this.remainingQuotaUsd = toBNWei(Math.max(quota.wdQuota - quota.usedWdQuota, 0));
      this.l1TokenPricesUsd = refreshedPrices;
    } catch (err) {
      this.logger.warn({
        at: "BinanceClient#refresh",
        message: "Failed to refresh Binance withdrawal quota; origin-via-Binance capacity checks disabled",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  isOperational(chainId: number, l1Token: Address): boolean {
    if (!hasBinanceRoute(chainId, l1Token)) {
      return false;
    }
    return isDefined(this.remainingQuotaUsd) && this.remainingQuotaUsd.gt(bnZero);
  }

  // Callers that want headroom for concurrent draws should scale fillAmount up beforehand.
  canAccommodate(fillAmount: BigNumber, fillDecimals: number, chainId: number, l1Token: Address): boolean {
    if (!this.isOperational(chainId, l1Token)) {
      return false;
    }
    const priceUsd = this.l1TokenPricesUsd.get(l1Token.toNative());
    if (!isDefined(priceUsd)) {
      return false;
    }
    const fillUsd = fillAmount.mul(priceUsd).div(BigNumber.from(10).pow(fillDecimals));
    return fillUsd.lte(this.remainingQuotaUsd);
  }

  private static async getBinanceSecretKey(): Promise<string | undefined> {
    BinanceClient.binanceSecretKeyPromise ??= BinanceClient.retrieveBinanceSecretKeyFromCLIArgs();
    return BinanceClient.binanceSecretKeyPromise;
  }

  private static async retrieveBinanceSecretKeyFromCLIArgs(): Promise<string | undefined> {
    const args = minimist(process.argv.slice(2), { string: ["binanceSecretKey"] });
    if (!isDefined(args.binanceSecretKey)) {
      return undefined;
    }
    const binanceKeys = await retrieveGckmsKeys(getGckmsConfig([args.binanceSecretKey]));
    if (binanceKeys.length === 0) {
      return undefined;
    }
    return binanceKeys[0].slice(2);
  }
}
