import { RedisCache } from "../../caching/RedisCache";
import { AugmentedTransaction, TransactionClient } from "../../clients";
import { BigNumber, winston } from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";

export abstract class BaseAdapter implements RebalancerAdapter {
  protected transactionClient: TransactionClient;
  protected redisCache: RedisCache;
  protected initialized = false;

  protected REDIS_PREFIX: string;
  protected REDIS_KEY_PENDING_ORDER: string;

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
