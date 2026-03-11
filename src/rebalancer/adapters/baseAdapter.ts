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
  ethers,
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

export enum STATUS {
  PENDING_BRIDGE_PRE_DEPOSIT,
  PENDING_DEPOSIT,
  PENDING_SWAP,
  PENDING_WITHDRAWAL,
}
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
const rebalancerStatusTrackingNameSpace: string | undefined = process.env.REBALANCER_STATUS_TRACKING_NAMESPACE
  ? String(process.env.REBALANCER_STATUS_TRACKING_NAMESPACE)
  : undefined;

export abstract class BaseAdapter implements RebalancerAdapter {
  protected transactionClient: TransactionClient;
  protected redisCache: RedisCache;
  protected baseSignerAddress: EvmAddress;
  protected initialized = false;
  protected priceClient: PriceClient;
  protected multicallerClient: MultiCallerClient;

  protected availableRoutes: RebalanceRoute[];
  protected allDestinationChains: Set<number>;
  protected allSourceChains: Set<number>;
  protected allSourceTokens: Set<string>;

  protected lastUpdateTimestamp = 0;
  protected pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } };

  protected REDIS_PREFIX: string;

  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {
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
  abstract getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  abstract getEstimatedCost(
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    debugLog: boolean
  ): Promise<BigNumber>;
  abstract getPendingOrders(): Promise<string[]>;

  // ////////////////////////////////////////////////////////////
  // PROTECTED REDIS HELPER METHODS
  // ////////////////////////////////////////////////////////////

  protected async _redisUpdateOrderStatus(cloid: string, oldStatus: number, status: number): Promise<void> {
    const oldOrderStatusKey = this._redisGetOrderStatusKey(oldStatus);
    const newOrderStatusKey = this._redisGetOrderStatusKey(status);
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
    ttlOverride?: number
  ): Promise<void> {
    const orderStatusKey = this._redisGetOrderStatusKey(status);
    const orderDetailsKey = `${this._redisGetPendingOrderKey()}:${cloid}`;

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
          : ttlOverride ?? 60 * 60 // default to 1 hour
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
    // We want to make sure that cloids are unique even if we rotate the redis cache namespace, so we can use
    // the current unix timestamp since we are assuming that we are never going to create multiple new orders
    // for the same exchange simultaneously.
    const unixTimestamp = getCurrentTime();

    // @dev Hyperliquid requires a 128 bit/16 byte string for a cloid, Binance doesn't seem to have any requirements.
    return ethers.utils.hexZeroPad(ethers.utils.hexValue(unixTimestamp), 16);
  }

  protected async _redisGetOrderDetails(cloid: string): Promise<OrderDetails> {
    const orderDetailsKey = `${this._redisGetPendingOrderKey()}:${cloid}`;
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

  protected async _redisDeleteOrder(cloid: string, currentStatus: number): Promise<void> {
    const orderStatusKey = this._redisGetOrderStatusKey(currentStatus);
    const orderDetailsKey = `${this._redisGetPendingOrderKey()}:${cloid}`;
    const result = await Promise.all([
      this.redisCache.sRem(orderStatusKey, cloid),
      this.redisCache.del(orderDetailsKey),
    ]);
    this.logger.debug({
      at: "BaseAdapter._redisDeleteOrder",
      message: `Deleted order details for cloid ${cloid} under key ${orderDetailsKey} and from status set ${orderStatusKey}`,
      result,
    });
  }

  protected _redisGetOrderStatusKey(status: STATUS): string {
    let orderStatusKey: string;
    switch (status) {
      case STATUS.PENDING_DEPOSIT:
        orderStatusKey = this.REDIS_PREFIX + "pending-deposit";
        break;
      case STATUS.PENDING_SWAP:
        orderStatusKey = this.REDIS_PREFIX + "pending-swap";
        break;
      case STATUS.PENDING_WITHDRAWAL:
        orderStatusKey = this.REDIS_PREFIX + "pending-withdrawal";
        break;
      case STATUS.PENDING_BRIDGE_PRE_DEPOSIT:
        orderStatusKey = this.REDIS_PREFIX + "pending-bridge-pre-deposit";
        break;
      default:
        throw new Error(`Invalid status: ${status}`);
    }
    return orderStatusKey;
  }

  protected _redisGetLatestNonceKey(): string {
    return this.REDIS_PREFIX + "latest-nonce";
  }

  protected _redisGetPendingOrderKey(): string {
    return this.REDIS_PREFIX + "pending-order";
  }

  // @dev Call this function before making any calls to sMembers to ensure that we are not returning any expired orders
  // that no longer have an order details key in Redis.
  protected async _redisCleanupPendingOrders(status: STATUS): Promise<void> {
    // If sMembers don't expire and don't have a notion of TTL, so check if order detail keys have expired. If they have,
    // then delete the member from the set.
    const sMembers = await this.redisCache.sMembers(this._redisGetOrderStatusKey(status));
    const orderDetails = await Promise.all(sMembers.map((cloid) => this._redisGetOrderDetails(cloid)));
    await forEachAsync(sMembers, async (cloid, i) => {
      if (!isDefined(orderDetails[i])) {
        this.logger.debug({
          at: "BaseAdapter._redisCleanupPendingOrders",
          message: `Deleting expired order details for cloid ${cloid} from status set ${this._redisGetOrderStatusKey(
            status
          )}`,
        });
        await this._redisDeleteOrder(cloid, status);
      }
    });
  }

  protected async _redisGetPendingBridgesPreDeposit(): Promise<string[]> {
    await this._redisCleanupPendingOrders(STATUS.PENDING_BRIDGE_PRE_DEPOSIT);
    const sMembers = await this.redisCache.sMembers(this._redisGetOrderStatusKey(STATUS.PENDING_BRIDGE_PRE_DEPOSIT));
    return sMembers;
  }

  protected async _redisGetPendingDeposits(): Promise<string[]> {
    await this._redisCleanupPendingOrders(STATUS.PENDING_DEPOSIT);
    const sMembers = await this.redisCache.sMembers(this._redisGetOrderStatusKey(STATUS.PENDING_DEPOSIT));
    return sMembers;
  }

  protected async _redisGetPendingSwaps(): Promise<string[]> {
    await this._redisCleanupPendingOrders(STATUS.PENDING_SWAP);
    const sMembers = await this.redisCache.sMembers(this._redisGetOrderStatusKey(STATUS.PENDING_SWAP));
    return sMembers;
  }

  protected async _redisGetPendingWithdrawals(): Promise<string[]> {
    await this._redisCleanupPendingOrders(STATUS.PENDING_WITHDRAWAL);
    const sMembers = await this.redisCache.sMembers(this._redisGetOrderStatusKey(STATUS.PENDING_WITHDRAWAL));
    return sMembers;
  }

  protected async _redisGetPendingOrders(): Promise<string[]> {
    const [pendingDeposits, pendingSwaps, pendingWithdrawals, pendingBridgesPreDeposit] = await Promise.all([
      this._redisGetPendingDeposits(),
      this._redisGetPendingSwaps(),
      this._redisGetPendingWithdrawals(),
      this._redisGetPendingBridgesPreDeposit(),
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

  protected async _getERC20Balance(chainId: number, tokenAddress: string): Promise<BigNumber> {
    const provider = await getProvider(chainId);
    const connectedSigner = this.baseSigner.connect(provider);
    const erc20 = new Contract(tokenAddress, ERC20.abi, connectedSigner);
    const balance = await erc20.balanceOf(this.baseSignerAddress.toNative());
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
