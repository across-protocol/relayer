import { Binance } from "binance-api-node";
import {
  assert,
  BigNumber,
  BINANCE_NETWORKS,
  getAccountCoins,
  getBinanceApiClient,
  getNetworkName,
  getRedisCache,
  Signer,
  winston,
} from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";
import { RebalancerConfig } from "../RebalancerConfig";
import { RedisCache } from "../../caching/RedisCache";

enum STATUS {
  PENDING_DEPOSIT,
  PENDING_SWAP,
  PENDING_WITHDRAWAL,
}

export class BinanceStablecoinSwapAdapter implements RebalancerAdapter {
  private binanceApiClient: Binance;
  private redisCache: RedisCache;
  private availableRoutes: RebalanceRoute[];
  private initialized = false;

  REDIS_PREFIX = "binance-stablecoin-swap:";
  REDIS_KEY_PENDING_DEPOSIT = this.REDIS_PREFIX + "pending-deposit";
  REDIS_KEY_PENDING_SWAP = this.REDIS_PREFIX + "pending-swap";
  REDIS_KEY_PENDING_WITHDRAWAL = this.REDIS_PREFIX + "pending-withdrawal";
  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {}
  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    this.redisCache = (await getRedisCache(this.logger)) as RedisCache;
    this.binanceApiClient = await getBinanceApiClient(process.env.BINANCE_API_BASE);

    const coins = await getAccountCoins(this.binanceApiClient);
    this.availableRoutes = _availableRoutes;
    for (const route of this.availableRoutes) {
      const { sourceChain, destinationChain, sourceToken, destinationToken } = route;
      assert(BINANCE_NETWORKS[sourceChain], `Source chain ${sourceChain} not supported by Binance`);
      assert(BINANCE_NETWORKS[destinationChain], `Destination chain ${destinationChain} not supported by Binance`);
      const sourceCoin = coins.find((coin) => coin.symbol === sourceToken);
      assert(sourceCoin, `Source token ${sourceToken} not found in account coins`);
      const destinationCoin = coins.find((coin) => coin.symbol === destinationToken);
      assert(destinationCoin, `Destination token ${destinationToken} not found in account coins`);
      assert(
        sourceCoin.networkList.find((network) => network.name === BINANCE_NETWORKS[sourceChain]),
        `Source token ${sourceToken} not found in network ${BINANCE_NETWORKS[sourceChain]}`
      );
      assert(
        destinationCoin.networkList.find((network) => network.name === BINANCE_NETWORKS[destinationChain]),
        `Destination token ${destinationToken} not found in network ${BINANCE_NETWORKS[destinationChain]}`
      );
    }
    this.initialized = true;
  }
  async initializeRebalance(rebalanceRoute: RebalanceRoute): Promise<void> {
    this._assertInitialized();
    const { sourceChain, sourceToken, destinationToken, destinationChain } = rebalanceRoute;
    // Transfer to Binance using depositAddress for coin.
    const accountCoins = await getAccountCoins(this.binanceApiClient);
    const sourceCoin = accountCoins.find((coin) => coin.symbol === sourceToken);
    console.log("source coin", sourceCoin);
    const destinationCoin = accountCoins.find((coin) => coin.symbol === destinationToken);
    console.log("destination coin", destinationCoin);
    const destinationNetwork = destinationCoin.networkList.find(
      (network) => network.name === BINANCE_NETWORKS[destinationChain]
    );

    // Convert input amount to destination amount and check its larger than minimum size
    // const minimumWithdrawalSize = destinationChain.withdrawMin;
    // const maximumWithdrawalSize = destinationChain.withdrawMax;

    // const latestPx = await this._getLatestPrice(sourceToken, destinationToken, true);
    // const amountToTransferConverted = rebalanceRoute.maxAmountToTransfer.mul(latestPx).div(toBNWei("1"));

    const depositAddress = await this.binanceApiClient.depositAddress({
      coin: sourceCoin.symbol,
      network: BINANCE_NETWORKS[sourceChain],
    });
    console.log(`deposit address on ${getNetworkName(sourceChain)} for ${sourceCoin.symbol}`, depositAddress);
  }
  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();
    const pendingOrders = await this._redisGetPendingOrders();
    console.log("pending orders", pendingOrders);
    // PENDING_DEPOSIT: place new orders if enough balance and update status to PENDING_SWAP
    // PENDING_SWAP: Load open orders and matching fills. If a matching fill is found, initiate a withdrawal from Binance
    // and update status to PENDING_WITHDRAWAL_FROM_BINANCE. If no matching fill is found and no open order, then
    // replace the order. Otherwise do nothing.
    // PENDING_WITHDRAWAL: Check if withdrawal has been finalized, if it has then delete the order. Only look at withdrawals
    // with timestamp greater than matched fills for orders.
  }

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question.
  async getPendingRebalances(rebalanceRoute: RebalanceRoute): Promise<{ [chainId: number]: BigNumber }> {
    this._assertInitialized();
    return {};
    // For any orders with pending status add virtual balance to destination chain.
    // We need to make sure not to count orders with pending withdrawal status that have already finalized otherwise
    // we'll double count them. To do this, get the total unfinalized withdrawal amount from Binance and the
    // PENDING_WITHDRAWAL status orders. For each order, check if the order amount is less than the unfinalized withdrawal
    // amount. If it is, then we can assume this order is still pending, so subtract from the unfinalized withdrawal
    // amount counter and go to the next order. If the order amount is greater than the unfinalized withdrawal
    // then we can assume this order has finalized, so subtract a virtual balance credit for the order amount.
  }

  _redisGetOrderStatusKey(status: STATUS): string {
    let orderStatusKey: string;
    switch (status) {
      case STATUS.PENDING_DEPOSIT:
        orderStatusKey = this.REDIS_KEY_PENDING_DEPOSIT;
        break;
      case STATUS.PENDING_SWAP:
        orderStatusKey = this.REDIS_KEY_PENDING_SWAP;
        break;
      case STATUS.PENDING_WITHDRAWAL:
        orderStatusKey = this.REDIS_KEY_PENDING_WITHDRAWAL;
        break;
      default:
        throw new Error(`Invalid status: ${status}`);
    }
    return orderStatusKey;
  }

  async _redisGetPendingOrders(): Promise<string[]> {
    const [pendingDeposits, pendingSwaps, pendingWithdrawals] = await Promise.all([
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_DEPOSIT),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_SWAP),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_WITHDRAWAL),
    ]);
    return [...pendingDeposits, ...pendingSwaps, ...pendingWithdrawals];
  }

  private _assertInitialized(): void {
    assert(this.initialized, "BinanceStablecoinSwapAdapter not initialized");
  }
}
