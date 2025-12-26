import { RedisCache } from "../../caching/RedisCache";
import { AugmentedTransaction, TransactionClient } from "../../clients";
import { Address, BigNumber, ConvertDecimals, ethers, getTokenInfo, winston } from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";

export abstract class BaseAdapter implements RebalancerAdapter {
  protected transactionClient: TransactionClient;
  protected redisCache: RedisCache;
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
  abstract initializeRebalance(rebalanceRoute: RebalanceRoute): Promise<void>;
  abstract updateRebalanceStatuses(): Promise<void>;
  abstract getPendingRebalances(rebalanceRoute: RebalanceRoute): Promise<{ [chainId: number]: BigNumber }>;

  protected abstract _redisGetOrderStatusKey(status: number): string;

  protected async _redisCreateOrder(cloid: string, status: number, rebalanceRoute: RebalanceRoute): Promise<void> {
    const orderStatusKey = this._redisGetOrderStatusKey(status);
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;

    console.log(`_redisCreateOrder: Saving order to status set: ${orderStatusKey}`);
    console.log(`_redisCreateOrder: Saving new order details under key ${orderDetailsKey}`, rebalanceRoute);

    // Create a new order in Redis. We use infinite expiry because we will delete this order after its no longer
    // used.
    const results = await Promise.all([
      this.redisCache.sAdd(orderStatusKey, cloid.toString()),
      this.redisCache.set(
        orderDetailsKey,
        JSON.stringify({ ...rebalanceRoute, maxAmountToTransfer: rebalanceRoute.maxAmountToTransfer.toString() }),
        Number.POSITIVE_INFINITY
      ),
    ]);
    console.log("_redisCreateOrder: results", results);
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

  protected async _redisGetOrderDetails(cloid: string): Promise<RebalanceRoute> {
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;
    const orderDetails = await this.redisCache.get<string>(orderDetailsKey);
    if (!orderDetails) {
      return undefined;
    }
    const rebalanceRoute = JSON.parse(orderDetails);
    return {
      ...rebalanceRoute,
      maxAmountToTransfer: BigNumber.from(rebalanceRoute.maxAmountToTransfer),
    };
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
