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

// A route leg is a (coin, Binance network) pair -- the unit Binance actually toggles. Deposits and
// withdrawals are enabled independently of one another, and a suspended pair stays listed in the API
// response, so presence in the static route map says nothing about whether a transfer will be accepted.
export type BinanceLeg = { coin: string; network: string };
export type BinanceLegAvailability = BinanceLeg & { depositEnable?: boolean; withdrawEnable?: boolean };

// A (chain, token) pair the caller expects Binance to service, used to scope availability logging to the
// routes actually in use rather than Binance's entire coin catalogue.
export type BinanceRoute = { chainId: number; l1Token: Address };

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

  // Per-leg deposit/withdraw enablement from the last successful accountCoins read, keyed by legKey().
  // Undefined before the first refresh and after any failure.
  private legAvailability: Map<string, BinanceLegAvailability> | undefined;

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

  /**
   * Refresh both cached views of Binance state: the account-wide withdrawal quota and the per-leg
   * deposit/withdraw enablement. `routes` scopes availability logging to the (chain, token) pairs the
   * caller relies on; pass none to skip that logging.
   */
  async refresh(routes: BinanceRoute[] = []): Promise<void> {
    await Promise.all([this.refreshQuota(), this.refreshLegAvailability(routes)]);
  }

  // Strict-fail: any error clears the cache.
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

  /**
   * Binance opens and closes deposits/withdrawals per coin and network -- during chain upgrades, wallet
   * maintenance, or unilaterally -- without any change on our side. accountCoins is the only pre-transfer
   * signal for this, so snapshot it each cycle and log what we see: today the state of these routes is
   * invisible to us until a transfer is rejected.
   */
  private async refreshLegAvailability(routes: BinanceRoute[]): Promise<void> {
    const previous = this.legAvailability;
    this.legAvailability = undefined;

    let availability: Map<string, BinanceLegAvailability>;
    try {
      const coins = await getAccountCoins(this.api);
      availability = new Map(
        coins.flatMap(({ symbol, networkList }) =>
          (networkList ?? []).map((network) => [
            BinanceClient.legKey({ coin: symbol, network: network.name }),
            {
              coin: symbol,
              network: network.name,
              depositEnable: network.depositEnable,
              withdrawEnable: network.withdrawEnable,
            },
          ])
        )
      );
    } catch (err) {
      this.logger.warn({
        at: "BinanceClient#refresh",
        message: "Failed to refresh Binance route availability; routes will not be gated on it this cycle",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.legAvailability = availability;
    this.logLegAvailability(routes, previous);
  }

  /**
   * Report the live state of the legs backing `routes`. A route needs two legs -- deposit into Binance on
   * one network, withdraw out on another -- so report the hub leg alongside each route's own leg.
   */
  private logLegAvailability(routes: BinanceRoute[], previous: Map<string, BinanceLegAvailability> | undefined): void {
    const legs = new Map<string, BinanceLeg>();
    routes.forEach(({ chainId, l1Token }) => {
      [chainId, BinanceClient.hubChainId].forEach((legChainId) => {
        const leg = this.resolveLeg(legChainId, l1Token);
        if (isDefined(leg)) {
          legs.set(BinanceClient.legKey(leg), leg);
        }
      });
    });
    if (legs.size === 0) {
      return;
    }

    const observed: BinanceLegAvailability[] = [];
    const unrecognised: BinanceLeg[] = [];
    legs.forEach((leg, key) => {
      const state = this.legAvailability?.get(key);
      if (isDefined(state)) {
        observed.push(state);
      } else {
        unrecognised.push(leg);
      }
    });

    this.logger.debug({
      at: "BinanceClient#refresh",
      message: "Binance route availability",
      legs: observed,
      // Legs Binance doesn't report on. Treated as enabled (see isLegEnabled), but worth surfacing: a coin
      // or network we can't find is usually a symbol-mapping bug rather than a genuine Binance change.
      unrecognisedLegs: unrecognised,
    });

    const disabled = observed.filter(({ depositEnable, withdrawEnable }) => !depositEnable || !withdrawEnable);
    if (disabled.length > 0) {
      this.logger.warn({
        at: "BinanceClient#refresh",
        message: "🚧 Binance has suspended deposits or withdrawals on configured routes",
        disabledLegs: disabled.map((leg) => ({ ...leg, changedThisCycle: BinanceClient.legChanged(leg, previous) })),
      });
    }

    const recovered = observed.filter(
      (leg) => leg.depositEnable && leg.withdrawEnable && BinanceClient.legChanged(leg, previous)
    );
    if (recovered.length > 0) {
      this.logger.info({
        at: "BinanceClient#refresh",
        message: "✅ Binance has resumed deposits and withdrawals on previously suspended routes",
        recoveredLegs: recovered,
      });
    }
  }

  /**
   * True unless Binance explicitly reports this leg as disabled.
   *
   * Unknown means enabled. The snapshot is absent on the first cycle and after an API failure, Binance
   * omits these flags on some responses, and a coin/network pair we can't resolve is not evidence of a
   * suspension. Only an explicit `false` closes a route, so a Binance outage degrades to the previous
   * behaviour of not checking at all rather than stranding every route at once. Mirrors
   * `isBinanceNetworkWithdrawEnabled` in src/rebalancer/adapters/binance.ts.
   */
  private isLegEnabled(chainId: number, l1Token: Address, direction: "deposit" | "withdraw"): boolean {
    const leg = this.resolveLeg(chainId, l1Token);
    if (!isDefined(leg)) {
      return true;
    }
    const state = this.legAvailability?.get(BinanceClient.legKey(leg));
    const enabled = direction === "deposit" ? state?.depositEnable : state?.withdrawEnable;
    return enabled ?? true;
  }

  // True if Binance currently accepts deposits of l1Token's coin on chainId's network.
  isDepositEnabled(chainId: number, l1Token: Address): boolean {
    return this.isLegEnabled(chainId, l1Token, "deposit");
  }

  // True if Binance currently permits withdrawals of l1Token's coin to chainId's network.
  isWithdrawEnabled(chainId: number, l1Token: Address): boolean {
    return this.isLegEnabled(chainId, l1Token, "withdraw");
  }

  /**
   * True if Binance can currently move l1Token off chainId and back to the hub chain: it must accept the
   * deposit on chainId's network *and* permit the withdrawal on the hub chain's network. The two legs are
   * toggled independently, so checking either one alone is not sufficient.
   */
  canDrainToHubChain(chainId: number, l1Token: Address): boolean {
    return this.isDepositEnabled(chainId, l1Token) && this.isWithdrawEnabled(BinanceClient.hubChainId, l1Token);
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

  // Binance bridges are mainnet-only: BinanceCEXBridge refuses to construct on any other hub chain.
  private static readonly hubChainId = CHAIN_IDs.MAINNET;

  private static legKey({ coin, network }: BinanceLeg): string {
    return `${coin}:${network}`;
  }

  private static legChanged(
    leg: BinanceLegAvailability,
    previous: Map<string, BinanceLegAvailability> | undefined
  ): boolean {
    const before = previous?.get(BinanceClient.legKey(leg));
    return (
      isDefined(before) && (before.depositEnable !== leg.depositEnable || before.withdrawEnable !== leg.withdrawEnable)
    );
  }

  // Map a (chain, L1 token) pair onto the coin and network names Binance uses. Returns undefined when the
  // chain isn't a Binance network or the token isn't recognised on the hub chain.
  private resolveLeg(chainId: number, l1Token: Address): BinanceLeg | undefined {
    const network = BINANCE_NETWORKS[chainId];
    if (!isDefined(network)) {
      return undefined;
    }
    try {
      const { symbol } = getTokenInfo(l1Token, BinanceClient.hubChainId);
      // BinanceCEXBridge applies the same WBNB -> BNB mapping; resolveBinanceCoinSymbol covers the rest.
      return { coin: symbol === "WBNB" ? "BNB" : resolveBinanceCoinSymbol(symbol), network };
    } catch {
      return undefined;
    }
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
