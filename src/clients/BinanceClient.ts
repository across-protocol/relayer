import Binance, { HttpMethod, type Binance as BinanceApi } from "binance-api-node";
import minimist from "minimist";
import { coerce, create, number, string, type } from "superstruct";
import winston from "winston";
import { hasBinanceRoute } from "../common";
import { Address, assert, BigNumber, bnZero, getGckmsConfig, isDefined, retrieveGckmsKeys, toBNWei } from "../utils";
import type { WithdrawalQuota } from "../utils/BinanceUtils";

export type { WithdrawalQuota };

// `type()` over `object()` to tolerate additional fields Binance may add later.
const numberish = coerce(number(), string(), (s) => Number(s));

const WithdrawalQuotaSS = type({
  wdQuota: numberish,
  usedWdQuota: numberish,
});

export type BinanceClientOptions = {
  logger: winston.Logger;
  url?: string;
};

export class BinanceClient {
  private static binanceSecretKeyPromise: Promise<string | undefined> | undefined = undefined;

  // Undefined before first refresh and after any failure — treated as "no capacity".
  private remainingQuotaUsd: BigNumber | undefined;

  private constructor(
    private readonly api: BinanceApi,
    private readonly logger: winston.Logger
  ) {}

  static async create(options: BinanceClientOptions): Promise<BinanceClient> {
    const { logger, url = "https://api.binance.com" } = options;
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = (await BinanceClient.getBinanceSecretKey()) ?? process.env.BINANCE_HMAC_KEY;
    assert(isDefined(apiKey) && isDefined(secretKey), "Binance client cannot be constructed due to missing keys.");
    return new BinanceClient(Binance({ apiKey, apiSecret: secretKey, httpBase: url }), logger);
  }

  rawApi(): BinanceApi {
    return this.api;
  }

  async getWithdrawalLimits(): Promise<WithdrawalQuota> {
    const raw = await this.api.privateRequest("GET" as HttpMethod, "/sapi/v1/capital/withdraw/quota", {});
    return create(raw, WithdrawalQuotaSS);
  }

  // Strict-fail: any error wipes the cache, leaving capacity checks false until the next refresh.
  async refresh(): Promise<void> {
    this.remainingQuotaUsd = undefined;
    try {
      const quota = await this.getWithdrawalLimits();
      this.remainingQuotaUsd = toBNWei(Math.max(quota.wdQuota - quota.usedWdQuota, 0));
    } catch (err) {
      this.logger.warn({
        at: "BinanceClient#refresh",
        message: "Failed to refresh Binance withdrawal quota; capacity checks disabled",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Callers supply the USD-denominated amount to check; this client doesn't do pricing.
  canAccommodate(amountUsd: BigNumber, chainId: number, l1Token: Address): boolean {
    return (
      hasBinanceRoute(chainId, l1Token) &&
      isDefined(this.remainingQuotaUsd) &&
      this.remainingQuotaUsd.gt(bnZero) &&
      amountUsd.lte(this.remainingQuotaUsd)
    );
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
