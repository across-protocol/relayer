import Binance, { type Binance as BinanceApi } from "binance-api-node";
import minimist from "minimist";
import { coerce, create, number, string, type } from "superstruct";
import winston from "winston";
import { hasBinanceRoute } from "../common";
import {
  Address,
  assert,
  BigNumber,
  bnZero,
  CHAIN_IDs,
  getGckmsConfig,
  getTokenInfo,
  isDefined,
  retrieveGckmsKeys,
  toBNWei,
} from "../utils";
import {
  BINANCE_NETWORKS,
  getAccountCoins,
  getBinanceWithdrawalLimits,
  resolveBinanceCoinSymbol,
  type WithdrawalQuota,
} from "../utils/BinanceUtils";

export type { WithdrawalQuota };

// A (chain, token) pair the caller relies on Binance to service.
export type BinanceRoute = { chainId: number; l1Token: Address };

type LegState = { depositEnable?: boolean; withdrawEnable?: boolean };

// Binance bridges are mainnet-only; BinanceCEXBridge refuses to construct on any other hub chain.
const HUB_CHAIN_ID = CHAIN_IDs.MAINNET;

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

  // Undefined before first refresh and after any failure.
  private remainingQuotaUsd: BigNumber | undefined;
  private legs: Map<string, LegState> | undefined;

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
    const raw = await getBinanceWithdrawalLimits(this.api);
    return create(raw, WithdrawalQuotaSS);
  }

  // Strict-fail: any error clears the cache. `routes` scopes availability logging to the routes in use.
  async refresh(routes: BinanceRoute[] = []): Promise<void> {
    await Promise.all([this.refreshQuota(), this.refreshLegs(routes)]);
  }

  private async refreshQuota(): Promise<void> {
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

  // Binance opens and closes deposits/withdrawals per coin and network, and keeps suspended pairs listed,
  // so accountCoins is the only pre-transfer signal. Log what we see: this was previously invisible to us.
  private async refreshLegs(routes: BinanceRoute[]): Promise<void> {
    this.legs = undefined;
    try {
      const coins = await getAccountCoins(this.api);
      this.legs = new Map(
        coins.flatMap(({ symbol, networkList }) =>
          (networkList ?? []).map(({ name, depositEnable, withdrawEnable }): [string, LegState] => [
            `${symbol}:${name}`,
            { depositEnable, withdrawEnable },
          ])
        )
      );
    } catch (err) {
      this.logger.warn({
        at: "BinanceClient#refresh",
        message: "Failed to refresh Binance route availability; routes not gated on it this cycle",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const label = ({ chainId, l1Token }: BinanceRoute) => this.legKey(chainId, l1Token) ?? `?:${chainId}`;
    const suspended = routes.filter(({ chainId, l1Token }) => !this.canDrainToHubChain(chainId, l1Token));
    this.logger.debug({
      at: "BinanceClient#refresh",
      message: "Binance route availability",
      routes: routes.map(label),
    });
    if (suspended.length > 0) {
      this.logger.warn({
        at: "BinanceClient#refresh",
        message: "🚧 Binance has suspended drains for configured routes",
        suspended: suspended.map(label),
      });
    }
  }

  // A drain needs both legs -- deposit into Binance on chainId, withdraw out on the hub chain -- and Binance
  // toggles them independently. Only an explicit `false` closes a route: an absent snapshot (pre-refresh or
  // API failure) or an omitted flag means open, so a Binance outage degrades to not checking at all.
  canDrainToHubChain(chainId: number, l1Token: Address): boolean {
    return this.legOpen(chainId, l1Token, "depositEnable") && this.legOpen(HUB_CHAIN_ID, l1Token, "withdrawEnable");
  }

  private legOpen(chainId: number, l1Token: Address, flag: keyof LegState): boolean {
    const key = this.legKey(chainId, l1Token);
    return (isDefined(key) ? this.legs?.get(key)?.[flag] : undefined) ?? true;
  }

  // Binance's own (coin, network) naming for a route leg; undefined if either side is unrecognised.
  private legKey(chainId: number, l1Token: Address): string | undefined {
    const network = BINANCE_NETWORKS[chainId];
    if (!isDefined(network)) {
      return undefined;
    }
    try {
      const { symbol } = getTokenInfo(l1Token, HUB_CHAIN_ID);
      return `${symbol === "WBNB" ? "BNB" : resolveBinanceCoinSymbol(symbol)}:${network}`;
    } catch {
      return undefined;
    }
  }

  // Caller supplies USD amount; zero returns false.
  canWithdraw(amountUsd: BigNumber, chainId: number, l1Token: Address): boolean {
    return (
      hasBinanceRoute(chainId, l1Token) &&
      this.canDrainToHubChain(chainId, l1Token) &&
      isDefined(this.remainingQuotaUsd) &&
      amountUsd.gt(bnZero) &&
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
