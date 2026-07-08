import { AugmentedTransaction, getAcrossHost, MultiCallerClient, TransactionClient } from "../../clients";
import { TokenInfo } from "../../interfaces";
import {
  acrossApi,
  Address,
  assert,
  BigNumber,
  bnZero,
  CHAIN_IDs,
  coingecko,
  Contract,
  ConvertDecimals,
  defiLlama,
  delay,
  ERC20,
  EventSearchConfig,
  EvmAddress,
  forEachAsync,
  fromWei,
  getBlockForTimestamp,
  getProvider,
  getTokenInfo,
  getTokenInfoFromSymbol,
  isDefined,
  isWeekday,
  PriceClient,
  Signer,
  submitTransaction,
  toBNWei,
  winston,
} from "../../utils";
import { RedisCache } from "../../cache/Redis";
import { OrderDetails, RebalancerAdapter, RebalanceRoute } from "../utils/interfaces";
import { RebalancerConfig } from "../RebalancerConfig";
import {
  getCloidForAccount,
  STATUS,
  getPendingBridgeOrderKey,
  getPendingBridgeStatusSetKey,
  getRedisCacheForRebalancerStatusTracking,
  redisGetOrderDetailsForAdapter,
} from "../utils/utils";

export abstract class BaseAdapter implements RebalancerAdapter {
  private _baseSignerAddress?: EvmAddress;
  private _redisCache?: RedisCache;

  protected transactionClient: TransactionClient;
  protected initialized = false;
  protected priceClient: PriceClient;
  protected multicallerClient?: MultiCallerClient;

  // baseSignerAddress and redisCache are populated by initialize(); reads pre-init throw, writes go through the setter.
  public get baseSignerAddress(): EvmAddress {
    assert(isDefined(this._baseSignerAddress), "BaseAdapter: baseSignerAddress accessed before initialize()");
    return this._baseSignerAddress;
  }
  public set baseSignerAddress(value: EvmAddress) {
    this._baseSignerAddress = value;
  }
  protected get redisCache(): RedisCache {
    assert(isDefined(this._redisCache), "BaseAdapter: redisCache accessed before initialize()");
    return this._redisCache;
  }
  protected set redisCache(value: RedisCache) {
    this._redisCache = value;
  }

  protected availableRoutes: RebalanceRoute[] = [];
  protected allDestinationChains: Set<number> = new Set();
  protected allSourceChains: Set<number> = new Set();
  protected allSourceTokens: Set<string> = new Set();

  // Per-instance USD price cache for spread-cost estimation. The rebalancer is short-lived
  // (one cycle per invocation), so we don't apply a TTL here; matches the cache scope used
  // in CumulativeBalanceRebalancerClient._getTokenPriceUsd. If the adapter ever runs in a
  // long-lived process, revisit this with a time-based eviction.
  private readonly tokenPriceUsdCache = new Map<string, BigNumber>();

  protected abstract REDIS_PREFIX: string;

  constructor(
    readonly logger: winston.Logger,
    readonly config: RebalancerConfig,
    readonly baseSigner: Signer
  ) {
    this.transactionClient = new TransactionClient(logger);
    this.priceClient = new PriceClient(logger, [
      new acrossApi.PriceFeed({ host: getAcrossHost(CHAIN_IDs.MAINNET) }),
      new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
      new defiLlama.PriceFeed(),
    ]);
  }

  // ////////////////////////////////////////////////////////////
  // PUBLIC METHODS
  // ////////////////////////////////////////////////////////////

  /**
   * @notice This function should not submit any transactions, it should only set internal variables. Any initialization
   * transactions should be handled by the setApprovals function.
   * @param availableRoutes - The available routes to initialize the adapter for.
   */
  async initialize(availableRoutes: RebalanceRoute[]): Promise<void> {
    if (this.initialized) {
      return;
    }
    const redisCache = await getRedisCacheForRebalancerStatusTracking(this.logger);
    assert(isDefined(redisCache), "Rebalancer status tracking redis cache is required");
    this._redisCache = redisCache;

    this._baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());

    // Make sure each source token and destination token has an entry in token symbols map:
    for (const route of availableRoutes) {
      const { sourceToken, destinationToken, sourceChain, destinationChain } = route;
      this._getTokenInfo(sourceToken, sourceChain);
      this._getTokenInfo(destinationToken, destinationChain);
    }

    this.availableRoutes = availableRoutes;
    this.allDestinationChains = new Set<number>(this.availableRoutes.map((x) => x.destinationChain));
    this.allSourceChains = new Set<number>(this.availableRoutes.map((x) => x.sourceChain));
    this.allSourceTokens = new Set<string>(this.availableRoutes.map((x) => x.sourceToken));

    this.initialized = true;
  }

  async setApprovals(): Promise<void> {
    return;
  }

  supportsRoute(rebalanceRoute: RebalanceRoute): boolean {
    return this.availableRoutes.some(
      (route) =>
        route.sourceChain === rebalanceRoute.sourceChain &&
        route.sourceToken === rebalanceRoute.sourceToken &&
        route.destinationChain === rebalanceRoute.destinationChain &&
        route.destinationToken === rebalanceRoute.destinationToken
    );
  }

  // ////////////////////////////////////////////////////////////
  // ABSTRACT PUBLIC METHODS
  // ////////////////////////////////////////////////////////////

  abstract initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber>;
  abstract updateRebalanceStatuses(): Promise<void>;
  abstract sweepIntermediateBalances(): Promise<void>;
  abstract getPendingRebalances(account: EvmAddress): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  abstract getEstimatedCost(
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    debugLog: boolean
  ): Promise<BigNumber>;
  abstract getPendingOrders(): Promise<string[]>;

  // ////////////////////////////////////////////////////////////
  // PROTECTED REDIS HELPER METHODS
  // ////////////////////////////////////////////////////////////

  protected async _redisUpdateOrderStatus(
    cloid: string,
    oldStatus: number,
    status: number,
    account: EvmAddress
  ): Promise<void> {
    const oldOrderStatusKey = getPendingBridgeStatusSetKey(this.REDIS_PREFIX, oldStatus, account.toNative());
    const newOrderStatusKey = getPendingBridgeStatusSetKey(this.REDIS_PREFIX, status, account.toNative());
    const result = await Promise.all([
      this.redisCache.sRem(oldOrderStatusKey, cloid),
      this.redisCache.sAdd(newOrderStatusKey, cloid),
    ]);
    this.logger.debug({
      at: "BaseAdapter._redisUpdateOrderStatus",
      message: `Updated order status for cloid ${cloid} from ${oldOrderStatusKey} to ${newOrderStatusKey}`,
      result,
    });
  }

  protected async _redisCreateOrder(
    cloid: string,
    status: number,
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    account: EvmAddress,
    ttlOverride?: number
  ): Promise<void> {
    const orderStatusKey = getPendingBridgeStatusSetKey(this.REDIS_PREFIX, status, account.toNative());
    const orderDetailsKey = getPendingBridgeOrderKey(this.REDIS_PREFIX, cloid, account.toNative());

    // Create a new order in Redis. We use a TTL of 1 hour so that all orders that are finalized in 1 hour are
    // deleted from Redis and a RebalancerClient can sweep any excess balances that are left over on exchanges.
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;
    this.logger.debug({
      at: "BaseAdapter._redisCreateOrder",
      message: `Saving new order details for cloid ${cloid}`,
      orderStatusKey,
      orderDetailsKey,
      sourceToken,
      destinationToken,
      sourceChain,
      destinationChain,
      amountToTransfer: amountToTransfer.toString(),
    });

    const results = await Promise.all([
      // @todo: Should we set a TTL here?
      this.redisCache.sAdd(orderStatusKey, cloid.toString()),
      this.redisCache.set(
        orderDetailsKey,
        JSON.stringify({
          sourceToken,
          destinationToken,
          sourceChain,
          destinationChain,
          amountToTransfer: amountToTransfer.toString(),
        }),
        process.env.REBALANCER_PENDING_ORDER_TTL
          ? Number(process.env.REBALANCER_PENDING_ORDER_TTL)
          : (ttlOverride ?? 60 * 60) // default to 1 hour
      ),
    ]);
    this.logger.debug({
      at: "BaseAdapter._redisCreateOrder",
      message: `Completed saving new order details for cloid ${cloid}`,
      results,
    });
  }

  // Used to generate unique cloids for orders for adapters where we can inject our own cloid.
  protected async _redisGetNextCloid(): Promise<string> {
    return getCloidForAccount(this.baseSignerAddress.toNative());
  }

  protected _redisGetOrderDetails(cloid: string, account: EvmAddress): Promise<OrderDetails | undefined> {
    return redisGetOrderDetailsForAdapter(this.redisCache, this.REDIS_PREFIX, cloid, account);
  }

  // Variant for callers that have just listed `cloid` as pending and require the details to be present.
  // Throws if the redis entry is missing (e.g. expired between sMembers() and this lookup).
  protected async _redisGetOrderDetailsRequired(cloid: string, account: EvmAddress): Promise<OrderDetails> {
    const orderDetails = await this._redisGetOrderDetails(cloid, account);
    assert(isDefined(orderDetails), `Missing order details for cloid ${cloid}`);
    return orderDetails;
  }

  // Returns whether the status-set member was actually removed by this call (i.e. it was present
  // when sRem ran). `_redisCleanupPendingOrders` uses this to disambiguate a TTL prune from a
  // concurrent finalize; sequential sRem→del guarantees an observer seeing the details key gone
  // has also seen the set member removed, so the sRem return value is authoritative.
  protected async _redisDeleteOrder(cloid: string, currentStatus: number, account: EvmAddress): Promise<boolean> {
    const orderStatusKey = getPendingBridgeStatusSetKey(this.REDIS_PREFIX, currentStatus, account.toNative());
    const orderDetailsKey = getPendingBridgeOrderKey(this.REDIS_PREFIX, cloid, account.toNative());
    const memberRemoved = (await this.redisCache.sRem(orderStatusKey, cloid)) > 0;
    const detailsRemoved = await this.redisCache.del(orderDetailsKey);
    this.logger.debug({
      at: "BaseAdapter._redisDeleteOrder",
      message: `Deleted order details for cloid ${cloid}`,
      memberRemoved,
      detailsRemoved,
    });
    return memberRemoved;
  }

  protected _redisGetLatestNonceKey(): string {
    return this.REDIS_PREFIX + "latest-nonce";
  }

  // @dev Call this function before making any calls to sMembers to ensure that we are not returning any expired orders
  // that no longer have an order details key in Redis. Will only be used to cleanup orders owned by this.baseSignerAddress, for safety.
  private async _redisCleanupPendingOrders(status: STATUS, account: EvmAddress): Promise<void> {
    // If sMembers don't expire and don't have a notion of TTL, so check if order detail keys have expired. If they have,
    // then delete the member from the set. Reaching this branch means the order's TTL elapsed before the adapter
    // observed it transitioning out of `status` (e.g. via `_redisDeleteOrder` on finalization), so the rebalancer is
    // abandoning the order without emitting its usual finalization log. Surface a warn so operators can detect this.
    const statusSetKey = getPendingBridgeStatusSetKey(this.REDIS_PREFIX, status, account.toNative());
    const sMembers = await this.redisCache.sMembers(statusSetKey);
    const orderDetails = await Promise.all(sMembers.map((cloid) => this._redisGetOrderDetails(cloid, account)));
    await forEachAsync(sMembers, async (cloid, i) => {
      if (!isDefined(orderDetails[i])) {
        // A concurrent finalize (e.g. from another rebalancer instance sharing this signer address)
        // could have removed the details key but landed its set `sRem` after we captured `sMembers`.
        // `_redisDeleteOrder` is sequential (sRem then del) and returns whether sRem actually removed
        // the member: false means the finalize beat us to sRem and we should suppress; true means the
        // member was still present, i.e. a genuine TTL prune that deserves the warn.
        const memberRemoved = await this._redisDeleteOrder(cloid, status, account);
        if (!memberRemoved) {
          return;
        }
        this.logger.warn({
          at: "BaseAdapter._redisCleanupPendingOrders",
          message: `⏰ Pruning expired pending order ${cloid} from status set ${statusSetKey} without finalization. The order's REBALANCER_PENDING_ORDER_TTL elapsed before it could progress out of this status.`,
          account: account.toNative(),
        });
        await this._onExpiredOrderPruned(status, cloid, account);
      }
    });
  }

  // Hook invoked after a pending order is pruned because its details key TTL elapsed (a genuine expiry, not a
  // concurrent finalize). Adapters override this to release venue-side state tied to the abandoned order — e.g.
  // the Binance adapter untags the order's exchange deposit so the Binance finalizer can reclaim the funds.
  protected async _onExpiredOrderPruned(_status: STATUS, _cloid: string, _account: EvmAddress): Promise<void> {
    return;
  }

  protected async _redisGetPendingBridgesPreDeposit(account: EvmAddress): Promise<string[]> {
    await this._redisCleanupPendingOrders(STATUS.PENDING_BRIDGE_PRE_DEPOSIT, account);
    const sMembers = await this.redisCache.sMembers(
      getPendingBridgeStatusSetKey(this.REDIS_PREFIX, STATUS.PENDING_BRIDGE_PRE_DEPOSIT, account.toNative())
    );
    return sMembers;
  }

  protected async _redisGetPendingDeposits(account: EvmAddress): Promise<string[]> {
    await this._redisCleanupPendingOrders(STATUS.PENDING_DEPOSIT, account);
    const sMembers = await this.redisCache.sMembers(
      getPendingBridgeStatusSetKey(this.REDIS_PREFIX, STATUS.PENDING_DEPOSIT, account.toNative())
    );
    return sMembers;
  }

  protected async _redisGetPendingSwaps(account: EvmAddress): Promise<string[]> {
    await this._redisCleanupPendingOrders(STATUS.PENDING_SWAP, account);
    const sMembers = await this.redisCache.sMembers(
      getPendingBridgeStatusSetKey(this.REDIS_PREFIX, STATUS.PENDING_SWAP, account.toNative())
    );
    return sMembers;
  }

  protected async _redisGetPendingWithdrawals(account: EvmAddress): Promise<string[]> {
    await this._redisCleanupPendingOrders(STATUS.PENDING_WITHDRAWAL, account);
    const sMembers = await this.redisCache.sMembers(
      getPendingBridgeStatusSetKey(this.REDIS_PREFIX, STATUS.PENDING_WITHDRAWAL, account.toNative())
    );
    return sMembers;
  }

  protected async _redisGetPendingOrders(account: EvmAddress): Promise<string[]> {
    const [pendingDeposits, pendingSwaps, pendingWithdrawals, pendingBridgesPreDeposit] = await Promise.all([
      this._redisGetPendingDeposits(account),
      this._redisGetPendingSwaps(account),
      this._redisGetPendingWithdrawals(account),
      this._redisGetPendingBridgesPreDeposit(account),
    ]);
    return [...pendingDeposits, ...pendingSwaps, ...pendingWithdrawals, ...pendingBridgesPreDeposit];
  }

  // ////////////////////////////////////////////////////////////
  // PROTECTED HELPER METHODS
  // ////////////////////////////////////////////////////////////

  protected _assertInitialized(): void {
    assert(this.initialized, "not initialized");
  }

  protected _assertRouteIsSupported(rebalanceRoute: RebalanceRoute): void {
    assert(
      this.supportsRoute(rebalanceRoute),
      `Route is not supported: ${rebalanceRoute.sourceToken} ${rebalanceRoute.sourceChain} -> ${rebalanceRoute.destinationToken} ${rebalanceRoute.destinationChain}`
    );
  }

  protected async _wait(seconds: number): Promise<void> {
    this.logger.debug({
      at: "BaseAdapter._wait",
      message: `Waiting for ${seconds} seconds...`,
    });
    await delay(seconds);
    return;
  }

  protected _getAmountConverter(
    originChain: number,
    originToken: Address,
    destinationChain: number,
    destinationToken: Address
  ): ReturnType<typeof ConvertDecimals> {
    const originTokenInfo = getTokenInfo(originToken, originChain);
    const destinationTokenInfo = getTokenInfo(destinationToken, destinationChain);
    return ConvertDecimals(originTokenInfo.decimals, destinationTokenInfo.decimals);
  }

  // SVM addresses currently unsupported
  protected _getTokenInfo(symbol: string, chainId: number): TokenInfo {
    return getTokenInfoFromSymbol(symbol, chainId);
  }

  protected async _getERC20Balance(chainId: number, tokenAddress: string, account: EvmAddress): Promise<BigNumber> {
    const provider = await getProvider(chainId);
    const erc20 = new Contract(tokenAddress, ERC20.abi, provider);
    const balance = await erc20.balanceOf(account.toNative());
    return BigNumber.from(balance.toString());
  }

  protected async _getEventSearchConfig(chainId: number, fromTimestampSeconds: number): Promise<EventSearchConfig> {
    const provider = await getProvider(chainId);
    const [fromBlock, toBlock] = await Promise.all([
      getBlockForTimestamp(this.logger, chainId, fromTimestampSeconds),
      provider.getBlock("latest"),
    ]);
    const maxLookBack = this.config.maxBlockLookBack[chainId];
    return { from: fromBlock, to: toBlock.number, maxLookBack };
  }

  protected _getOpportunityCostOfCapitalPctForRebalanceTime(timeElapsedInMilliseconds: number): number {
    // If the current time is a weekday or the rebalance end time is a weekday, then return the weekday opportunity cost of capital percentage,
    // otherwise return the weekend opportunity cost of capital percentage.
    const weekdayOpportunityCostOfCapitalPct = 0.04; // We charge 0.04% fixed for all rebalances taking place on a weekday
    const weekendOpportunityCostOfCapitalPct = 0; // We charge 0% fixed for all rebalances taking place on a weekend
    const rebalanceEndTime =
      new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).getTime() +
      timeElapsedInMilliseconds; // @dev We use EST here because isWeekday() also does accounting using EST.
    if (isWeekday() || isWeekday(new Date(rebalanceEndTime))) {
      return weekdayOpportunityCostOfCapitalPct;
    } else {
      return weekendOpportunityCostOfCapitalPct;
    }
  }

  protected async _submitTransaction(transaction: AugmentedTransaction): Promise<string> {
    return (await submitTransaction(transaction, this.transactionClient)).hash;
  }

  /**
   * Resolve the USD price for a token symbol, using the same lookup pattern as
   * CumulativeBalanceRebalancerClient: the hub-chain address is used as the cache key and the
   * oracle key, and a `RELAYER_TOKEN_PRICE_FIXED_<address>` env var can override the oracle
   * value. Returns an 18-decimal BigNumber USD price.
   */
  protected async _getTokenPriceUsd(token: string): Promise<BigNumber> {
    const cached = this.tokenPriceUsdCache.get(token);
    if (isDefined(cached)) {
      return cached;
    }
    const hubTokenAddress = getTokenInfoFromSymbol(token, this.config.hubPoolChainId).address.toNative();
    const fixedPriceEnv = process.env[`RELAYER_TOKEN_PRICE_FIXED_${hubTokenAddress}`];
    const priceUsd = isDefined(fixedPriceEnv)
      ? toBNWei(fixedPriceEnv)
      : toBNWei((await this.priceClient.getPriceByAddress(hubTokenAddress)).price);
    assert(priceUsd.gt(bnZero), `Unable to resolve positive USD price for ${token}`);
    this.tokenPriceUsdCache.set(token, priceUsd);
    return priceUsd;
  }

  /**
   * Oracle-derived fair cross-token price for a spot market, expressed as quote-per-base
   * (so `latestPrice` from an order book can be compared directly to it). The ratio is
   * dimensionless — both USD prices cancel out. Returns a plain number; callers handle the
   * percent-vs-decimal scaling appropriate for their downstream math.
   *
   * Use this in place of hardcoded `1` references for spread-vs-par calculations so non-par
   * markets (e.g. ETH/USDC) measure slippage correctly. For stablecoin pairs the ratio is
   * ≈ 1 and the formula reduces to the prior par-based form.
   */
  protected async _getFairCrossPrice(baseToken: string, quoteToken: string): Promise<number> {
    const [basePriceUsd, quotePriceUsd] = await Promise.all([
      this._getTokenPriceUsd(baseToken),
      this._getTokenPriceUsd(quoteToken),
    ]);
    // Both prices are 18-decimal BigNumbers; we expand the numerator by 1e18 before dividing
    // so integer division preserves precision, then convert back to a float via fromWei.
    return Number(fromWei(basePriceUsd.mul(toBNWei(1, 18)).div(quotePriceUsd), 18));
  }
}
