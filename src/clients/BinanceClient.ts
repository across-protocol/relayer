import Binance, { HttpMethod, type Binance as BinanceApi } from "binance-api-node";
import minimist from "minimist";
import { coerce, create, number, string, type } from "superstruct";
import { assert, getGckmsConfig, isDefined, retrieveGckmsKeys } from "../utils";
import type { WithdrawalQuota } from "../utils/BinanceUtils";

export type { WithdrawalQuota };

// `type()` over `object()` to tolerate additional fields Binance may add later.
const numberish = coerce(number(), string(), (s) => Number(s));

const WithdrawalQuotaSS = type({
  wdQuota: numberish,
  usedWdQuota: numberish,
});

export class BinanceClient {
  private static binanceSecretKeyPromise: Promise<string | undefined> | undefined = undefined;

  private constructor(private readonly api: BinanceApi) {}

  static async create(url = "https://api.binance.com"): Promise<BinanceClient> {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = (await BinanceClient.getBinanceSecretKey()) ?? process.env.BINANCE_HMAC_KEY;
    assert(isDefined(apiKey) && isDefined(secretKey), "Binance client cannot be constructed due to missing keys.");
    return new BinanceClient(Binance({ apiKey, apiSecret: secretKey, httpBase: url }));
  }

  rawApi(): BinanceApi {
    return this.api;
  }

  async getWithdrawalLimits(): Promise<WithdrawalQuota> {
    const raw = await this.api.privateRequest("GET" as HttpMethod, "/sapi/v1/capital/withdraw/quota", {});
    return create(raw, WithdrawalQuotaSS);
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
