import { RedisCache } from "../../caching/RedisCache";
import { AugmentedTransaction, TransactionClient } from "../../clients";
import { Address, BigNumber, ConvertDecimals, ethers, EvmAddress, getTokenInfo, winston } from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";

export interface OrderDetails {
  sourceToken: string;
  destinationToken: string;
  sourceChain: number;
  destinationChain: number;
  amountToTransfer: BigNumber;
}

export abstract class BaseAdapter implements RebalancerAdapter {
  protected transactionClient: TransactionClient;
  protected redisCache: RedisCache;
  protected baseSignerAddress: EvmAddress;

  protected initialized = false;

  protected REDIS_PREFIX: string;
  protected REDIS_KEY_PENDING_ORDER: string;
  // Key used to query latest cloid that uniquely identifies orders. Also used to set cloids when placing HL orders.
  protected REDIS_KEY_LATEST_NONCE: string;

  // TODO: Add redis functions here:

  constructor(readonly logger: winston.Logger) {
    this.transactionClient = new TransactionClient(logger);
  }

  abstract initialize(availableRoutes: RebalanceRoute[]): Promise<void>;
  abstract initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void>;
  abstract updateRebalanceStatuses(): Promise<void>;
  abstract getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  abstract getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber>;

  protected abstract _redisGetOrderStatusKey(status: number): string;

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
    amountToTransfer: BigNumber
  ): Promise<void> {
    const orderStatusKey = this._redisGetOrderStatusKey(status);
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;

    // Create a new order in Redis. We use infinite expiry because we will delete this order after its no longer
    // used.
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
        Number.POSITIVE_INFINITY
      ),
    ]);
    this.logger.debug({
      at: "BaseAdapter._redisCreateOrder",
      message: `Completed saving new order details for cloid ${cloid}`,
      results,
    });
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

  protected async _redisGetNextCloid(): Promise<string> {
    // Increment and get the latest nonce from Redis:
    const nonce = await this.redisCache.incr(`${this.REDIS_PREFIX}:${this.REDIS_KEY_LATEST_NONCE}`);

    return ethers.utils.hexZeroPad(ethers.utils.hexValue(nonce), 16);
  }

  protected async _redisGetOrderDetails(cloid: string): Promise<OrderDetails> {
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;
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
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;
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

  protected async _submitTransaction(transaction: AugmentedTransaction): Promise<void> {
    const { reason, succeed, transaction: txnRequest } = (await this.transactionClient.simulate([transaction]))[0];
    const { contract: targetContract, method, ...txnRequestData } = txnRequest;
    if (!succeed) {
      const message = `Failed to simulate ${targetContract.address}.${method}(${txnRequestData.args.join(", ")}) on ${
        txnRequest.chainId
      }`;
      throw new Error(`${message} (${reason})`);
    }

    const response = await this.transactionClient.submit(transaction.chainId, [transaction]);
    if (response.length === 0) {
      throw new Error(
        `Transaction succeeded simulation but failed to submit onchain to ${
          targetContract.address
        }.${method}(${txnRequestData.args.join(", ")}) on ${txnRequest.chainId}`
      );
    }
  }
}
