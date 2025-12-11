import { RedisClient } from "../../caching/RedisCache";
import { Contract } from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";

enum STATUS {
  PENDING_BRIDGE_TO_HYPEREVM,
  PENDING_SWAP,
  PENDING_BRIDGE_TO_DESTINATION_CHAIN,
}

// This adapter can be used to swap stables in Hyperliquid
export class HyperliquidStablecoinSwapAdapter implements RebalancerAdapter {
  private redisClient: RedisClient;

  REDIS_PREFIX = "hyperliquid-stablecoin-swap";
  // Key used to query latest cloid that uniquely identifies orders. Also used to set cloids when placing HL orders.
  REDIS_KEY_LATEST_NONCE = this.REDIS_PREFIX + "latest-nonce";
  // Returns all nonces corresponding to pending orders.
  REDIS_KEY_PENDING_ORDER_NONCES = thjis.REDIS_PREFIX + "pending-orders";
  REDIS_KEY_ORDER = this.REDIS_PREFIX + "order";

  // Contract used to deposit and withdraw tokens to and from Hypercore. This contract will custody all funds in
  // intermediate states so that balances don't get confused with main user balances.
  private hyperliquidHelper: Contract;

  constructor() {
    // TODO
  }

  async initializeRebalance(rebalanceRoute: RebalanceRoute): Promise<void> {
    // If source token is not USDC, USDT, or USDH, throw.
    // If destination token is same as source token, throw.
    // If source token is USDH then throw if source chain is not HyperEVM.
    // If source chain is not HyperEVM, then initiate CCTP/OFT transfer to HyperEVM and save order
    //     with status PENDING_BRIDGE_TO_HYPEREVM. Note: the transfer should be received at the HyperliquidHelper
    //     contract on HyperEVM.
    // Else source chain is HyperEVM, so atomically deposit into Hypercore and place order for destination token,
    //     and save order with status PENDING_SWAP. Call _depositToHypercoreAndPlaceOrder(). Use the
    //     HyperliquidHelper contract to deposit into Hypercore.
  }

  async finalizeRebalance(): Promise<void> {
    // For all orders with status PENDING_BRIDGE_TO_HYPEREVM, check if transfer has completed to HyperEVM, and if
    // it has then call _depositToHypercoreAndPlaceOrder(). Save the order with status PENDING_SWAP.
    // For all orders with status PENDING_SWAP, check if order has been filled, and if it has then call
    // _withdrawToHyperevm() and save order with status PENDING_WITHDRAWAL_TO_DESTINATION_CHAIN.
    // For all orders PENDING_BRIDGE_TO_DESTINATION_CHAIN, check if HyperEVM balance is sufficient and then
    // initiate CCTP/OFT transfer to destination chain, and then delete order.
    // this._bridgeToEvm()
  }

  private _depositToHypercoreAndPlaceOrder(rebalanceRoute: RebalanceRoute): Promise<void> {
    // For USDC, we need a contract that calls special CoreDepositWallet contract and then places an order on
    // HyperCore.
    // For other ERC20's, we need a contract that deposits into Hypercore and then places an order on Hypercore.
    //   this.hyperliquidHelper.depositToHypercore(
    //     toHyperEvmAddress(rebalanceRoute.sourceToken),
    //     toHyperEvmAddress(rebalanceRoute.destinationToken),
    //     rebalanceRoute.amount,
    //     latestSpotPriceX1e8,
    //     cloid
    //   )
  }

  private _withdrawToHyperevm(rebalanceRoute: RebalanceRoute): Promise<void> {
    // TODO
    //   this.hyperliquidHelper.withdrawToHyperevm(
    //     toHyperEvmAddress(rebalanceRoute.destinationToken),
    //     // Figure out how many tokens we received on core after the order settled:
    //     toUint64(rebalanceRoute.amount),
    //     this.user
    //   )
  }

  private _bridgeToEvm(rebalanceRoute: RebalanceRoute): Promise<void> {
    // TODO
    // const calls = [
    //     {
    //         target: toHyperEvmAddress(rebalanceRoute.destinationToken),
    //         calldata: abi.encodeFunctionData("approve", [cctpAddress, amount]),
    //         value: 0,
    //     },
    //     {
    //         target: cctpAddressToBytes32,
    //         calldata: abi.encodeFunctionData("depositForBurn", [...]),
    //         value: 0
    //     }
    // ]
    //   this.hyperliquidHelper.attemptCalls(
    //     calls
    //   )

  getPendingRebalances(): Promise<RebalanceRoute[]> {
    return Promise.resolve([]);
  }

  /** ****************************************************
   *
   * REDIS HELPER FUNCTIONS
   *
   ****************************************************/

  async _redisCreateOrder(status: STATUS, rebalanceRoute: RebalanceRoute): Promise<void> {
    // Increment and get the latest nonce from Redis:
    const nonce = await this.redisClient.incr(`${this.REDIS_PREFIX}:${this.REDIS_KEY_LATEST_NONCE}`);

    // Create a new order in Redis.
    const newOrderKey = `${this.REDIS_KEY_ORDER}:${nonce}`;
    await Promise.all([
      this.redisClient.set(
        newOrderKey,
        JSON.stringify({
          status,
          rebalanceRoute,
        })
      ),
      this.redisClient.sAdd(this.REDIS_KEY_PENDING_ORDER_NONCES, nonce.toString()),
    ]);
  }

  async _redisGetPendingOrderNonces(): Promise<number[]> {
    const pendingOrderNonces = await this.redisClient.sMembers(this.REDIS_KEY_PENDING_ORDER_NONCES);
    const pendingOrders = await Promise.all(
      pendingOrderNonces.map((nonce) => this.redisClient.get(`${this.REDIS_KEY_ORDER}:${nonce}`))
    );
    return pendingOrders.map((order) => JSON.parse(order));
  }

  async _redisDeleteOrder(nonce: number): Promise<void> {
    const orderKey = `${this.REDIS_KEY_ORDER}:${nonce}`;
    await Promise.all([
      this.redisClient.del(orderKey),
      this.redisClient.sRem(this.REDIS_KEY_PENDING_ORDER_NONCES, nonce.toString()),
    ]);
  }
}
