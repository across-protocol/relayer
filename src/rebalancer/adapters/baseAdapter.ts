import { RedisCache } from "../../caching/RedisCache";
import { AugmentedTransaction, getAcrossHost, MultiCallerClient, TransactionClient } from "../../clients";
import { TokenInfo } from "../../interfaces";
import {
  acrossApi,
  Address,
  assert,
  BigNumber,
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
  getBlockForTimestamp,
  getCurrentTime,
  getProvider,
  getRedisCache,
  getTokenInfo,
  getTokenInfoFromSymbol,
  isDefined,
  isWeekday,
  PriceClient,
  Signer,
  submitTransaction,
  winston,
} from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../utils/interfaces";
import { RebalancerConfig } from "../RebalancerConfig";
import { getRebalancerStatusTrackingNamespace } from "../utils/PendingBridgeRedis";
import { getCloidForTimestampAndAccount } from "../utils/cloid";
import { STATUS, getPendingBridgeOrderKey, getPendingBridgeStatusSetKey } from "../utils/utils";
export interface OrderDetails {
  sourceToken: string;
  destinationToken: string;
  sourceChain: number;
  destinationChain: number;
  amountToTransfer: BigNumber;
}

// @dev We should track order statuses in Redis in a separate namespace from the remainder of the application's
// Redis cache (e.g. the namespace we use for caching RPC responses) to avoid losing critical information about pending orders
// even when we want to rotate rest of the Redis cache without losing critical information about pending orders
const rebalancerStatusTrackingNameSpace: string | undefined = getRebalancerStatusTrackingNamespace();

export abstract class BaseAdapter implements RebalancerAdapter {
  public baseSignerAddress: EvmAddress;

  protected transactionClient: TransactionClient;
  protected redisCache: RedisCache;
  protected initialized = false;
  protected priceClient: PriceClient;
  protected multicallerClient: MultiCallerClient;

  protected availableRoutes: RebalanceRoute[];
  protected allDestinationChains: Set<number>;
  protected allSourceChains: Set<number>;
  protected allSourceTokens: Set<string>;

  protected REDIS_PREFIX: string;

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
    this.redisCache = (await getRedisCache(this.logger, undefined, rebalancerStatusTrackingNameSpace)) as RedisCache;

    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());

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
      redisNamespace: rebalancerStatusTrackingNameSpace,
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
    // We want cloids to stay unique even if we rotate the Redis namespace. Combine the current unix timestamp
    // with the relayer account so different relayer instances cannot collide even when they create orders in
    // the same second. This still assumes one relayer instance won't create multiple orders in the same second.
    const unixTimestamp = getCurrentTime();
    return getCloidForTimestampAndAccount(unixTimestamp, this.baseSignerAddress.toNative());
  }

  protected async _redisGetOrderDetails(cloid: string, account: EvmAddress): Promise<OrderDetails> {
    const orderDetailsKey = getPendingBridgeOrderKey(this.REDIS_PREFIX, cloid, account.toNative());
    const orderDetails = await this.redisCache.get<string>(orderDetailsKey);
    if (!orderDetails) {
      return undefined;
    }
    const rebalanceRoute = JSON.parse(orderDetails);
    return {
      ...rebalanceRoute,
      amountToTransfer: BigNumber.from(rebalanceRoute.amountToTransfer),
    };
  }

  protected async _redisDeleteOrder(cloid: string, currentStatus: number, account: EvmAddress): Promise<void> {
    const orderStatusKey = getPendingBridgeStatusSetKey(this.REDIS_PREFIX, currentStatus, account.toNative());
    const orderDetailsKey = getPendingBridgeOrderKey(this.REDIS_PREFIX, cloid, account.toNative());
    const result = await Promise.all([
      this.redisCache.sRem(orderStatusKey, cloid),
      this.redisCache.del(orderDetailsKey),
    ]);
    this.logger.debug({
      at: "BaseAdapter._redisDeleteOrder",
      message: `Deleted order details for cloid ${cloid}`,
      result,
    });
  }

  protected _redisGetLatestNonceKey(): string {
    return this.REDIS_PREFIX + "latest-nonce";
  }

  // @dev Call this function before making any calls to sMembers to ensure that we are not returning any expired orders
  // that no longer have an order details key in Redis. Will only be used to cleanup orders owned by this.baseSignerAddress, for safety.
  private async _redisCleanupPendingOrders(status: STATUS, account: EvmAddress): Promise<void> {
    // If sMembers don't expire and don't have a notion of TTL, so check if order detail keys have expired. If they have,
    // then delete the member from the set.
    const sMembers = await this.redisCache.sMembers(
      getPendingBridgeStatusSetKey(this.REDIS_PREFIX, status, account.toNative())
    );
    const orderDetails = await Promise.all(sMembers.map((cloid) => this._redisGetOrderDetails(cloid, account)));
    await forEachAsync(sMembers, async (cloid, i) => {
      if (!isDefined(orderDetails[i])) {
        this.logger.debug({
          at: "BaseAdapter._redisCleanupPendingOrders",
          message: `Deleting expired order details for cloid ${cloid} from status set ${getPendingBridgeStatusSetKey(this.REDIS_PREFIX, status, account.toNative())}`,
        });
        await this._redisDeleteOrder(cloid, status, account);
      }
    });
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

  // @todo: Add retry logic here! Or replace with the multicaller client. However, we can't easily swap in the MulticallerClient
  // because of the interplay between tracking order statuses in the RedisCache and confirming on chain transactions. Often times
  // we can only update an order status once its corresponding transaction has confirmed, which is different from how we use
  // the multicaller client normally where we enqueue txns in the core logic and execute all transactions optimistically once we
  // exit the core clients. In the Rebalancer use case we need to confirm transactions, but I've had trouble getting .wait()
  // to work, due to what seems like on-chain timeouts while waiting for txns to confirm.
  protected async _submitTransaction(transaction: AugmentedTransaction): Promise<string> {
    return (await submitTransaction(transaction, this.transactionClient)).hash;
  }
}
