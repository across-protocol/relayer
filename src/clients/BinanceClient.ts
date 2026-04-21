import Binance, { HttpMethod, type Binance as BinanceApi } from "binance-api-node";
import minimist from "minimist";
import { create, number, type } from "superstruct";
import { assert, getGckmsConfig, isDefined, retrieveGckmsKeys } from "../utils";
import type { WithdrawalQuota } from "../utils/BinanceUtils";

export type { WithdrawalQuota };

// Validates the quote-endpoint response shape at runtime. Uses `type()` (loose) rather
// than `object()` (strict) so that additional fields Binance may introduce in future
// API revisions do not cause the quota check to start failing.
const WithdrawalQuotaSS = type({
  wdQuota: number(),
  usedWdQuota: number(),
});

/**
 * Wrapper around the `binance-api-node` client. Encapsulates Binance API construction
 * (including GCKMS secret resolution) and endpoint helpers not exposed by the upstream
 * library. Constructed via the async `create()` factory since GCKMS retrieval is async.
 *
 * The module-level `getBinanceApiClient()` in `BinanceUtils` remains as a legacy entry
 * point for the rebalancer + finalizer, and will be migrated in follow-up work.
 */
export class BinanceClient {
  // Memoizes GCKMS retrieval so that concurrent `create()` callers share one key fetch
  // (mirrors the prior module-level memoization in BinanceUtils).
  private static binanceSecretKeyPromise: Promise<string | undefined> | undefined = undefined;

  private constructor(private readonly api: BinanceApi) {}

  static async create(url = "https://api.binance.com"): Promise<BinanceClient> {
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = (await BinanceClient.getBinanceSecretKey()) ?? process.env.BINANCE_HMAC_KEY;
    assert(isDefined(apiKey) && isDefined(secretKey), "Binance client cannot be constructed due to missing keys.");
    return new BinanceClient(Binance({ apiKey, apiSecret: secretKey, httpBase: url }));
  }

  // Exposes the underlying `binance-api-node` client for callers that still issue
  // low-level requests (deposit/withdraw/depositHistory). Retained during the transition
  // away from the module-level `getBinanceApiClient()` factory.
  rawApi(): BinanceApi {
    return this.api;
  }

  /**
   * Fetches the account's daily withdrawal quota, validated against the expected response
   * shape via superstruct. Throws on request failure or schema mismatch.
   */
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
