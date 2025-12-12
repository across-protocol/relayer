import { RedisCache } from "../../caching/RedisCache";
import { bnUint256Max, CHAIN_IDs, Contract, ERC20, ethers, EvmAddress, getRedisCache, Signer, toBNWei, TOKEN_SYMBOLS_MAP } from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";
import * as hl from "@nktkas/hyperliquid";

enum STATUS {
  PENDING_BRIDGE_TO_HYPEREVM,
  PENDING_SWAP,
  PENDING_BRIDGE_TO_DESTINATION_CHAIN,
}

interface SPOT_MARKET_META {
    index: number;
    quoteAssetIndex: number;
    baseAssetIndex: number;
    baseAssetName: string;
    quoteAssetName: string;
    minimumOrderSize: number;
}

// This adapter can be used to swap stables in Hyperliquid
export class HyperliquidStablecoinSwapAdapter implements RebalancerAdapter {
  private redisCache: RedisCache;

  REDIS_PREFIX = "hyperliquid-stablecoin-swap";
  // Key used to query latest cloid that uniquely identifies orders. Also used to set cloids when placing HL orders.
  REDIS_KEY_LATEST_NONCE = this.REDIS_PREFIX + "latest-nonce";
  // The following three keys map to Sets of order nonces where the order has the relevant status.
  REDIS_KEY_PENDING_BRIDGE_TO_HYPEREVM = this.REDIS_PREFIX + "pending-bridge-to-hyperliquid";
  REDIS_KEY_PENDING_SWAP = this.REDIS_PREFIX + "pending-swap";
  REDIS_KEY_PENDING_BRIDGE_TO_DESTINATION_CHAIN = this.REDIS_PREFIX + "pending-bridge-to-destination-chain";
  // The following stores the full order object for a given nonce.
  REDIS_KEY_ORDER = this.REDIS_PREFIX + "order";

  // Contract used to deposit and withdraw tokens to and from Hypercore. This contract will custody all funds in
  // intermediate states so that balances don't get confused with main user balances.
  private hyperliquidHelper: Contract;

  private baseSignerAddress: EvmAddress;

  private spotMarketMeta: { [name: string]: SPOT_MARKET_META } =  {
    "USDT-USDC": {
      index: 166,
      quoteAssetIndex: 268,
      baseAssetIndex: 0,
      quoteAssetName: "USDT",
      baseAssetName: "USDC",
      minimumOrderSize: 10,
    },
  }

  constructor(readonly baseSigner: Signer) {
    // TODO
  }

  async initialize(): Promise<void> {
    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.redisCache = (await getRedisCache()) as RedisCache;
    // this.hyperliquidHelper = new Contract(
    //     "todo",
    //     [],
    //     this.baseSigner
    // );

    // const usdcHyperEvm = new Contract(
    //     TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.HYPEREVM],
    //     ERC20.abi,
    //     this.baseSigner
    // );
    // const allowance = await usdcHyperEvm.allowance(this.baseSignerAddress.toNative(), this.hyperliquidHelper.address);
    // if (allowance.lt(toBNWei("1"))) {
    //     const txn = await usdcHyperEvm.approve(this.hyperliquidHelper.address, bnUint256Max);
    //     await txn.wait();
    //     console.log(`Approved USDC for HyperliquidHelper: ${txn.hash}`);
    // }
  }

  async initializeRebalance(rebalanceRoute: RebalanceRoute): Promise<void> {

    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const spotMarketData = await infoClient.spotMetaAndAssetCtxs();
    const marketData = spotMarketData[1].find((market) => market.coin === "@166");
    console.log(`Market data`, marketData);

    const openOrders = await infoClient.openOrders({ user: this.baseSignerAddress.toNative() });
    console.log(`Open orders`, openOrders);

    const spotClearingHouseState = await infoClient.spotClearinghouseState({ user: this.baseSignerAddress.toNative() });
    console.log(`Spot clearing house state`, spotClearingHouseState);

    await this._depositToHypercoreAndPlaceOrder(rebalanceRoute);

    // const spotMarketData = await getSpotMarketData(rebalanceRoute.sourceChain);
    // console.log(`Initializing rebalance for route: ${JSON.stringify(rebalanceRoute)}`);
    // if (rebalanceRoute.sourceChain !== CHAIN_IDs.HYPEREVM) {
    //     throw new Error("Source chain is not HyperEVM");
    // }

    // Spot Market Asset ID's:
    // - USDH-USDC: 230
    // - USDT-USDC: 166
    // - Set isBuy if buying quote asset, otherwise false.

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

  async pollForRebalanceCompletion(): Promise<void> {
    const subsClient = new hl.SubscriptionClient({
      transport: new hl.WebSocketTransport(),
    });
    console.log(`Created new subscription client, ${subsClient.transport.socket.url}`);
    console.log(`Polling for user fills for user: ${this.baseSignerAddress.toNative()}`);
    await subsClient.userFills({ user: this.baseSignerAddress.toNative() }, async (data) => {
      console.log("Received new user fills:", data);
    //   for (const fill of data.fills) {
    //     // Find order for fill.cloid:
    //     const order = await this._redisGetOrder(fill.oid);
    //     if (!order) {
    //       continue;
    //     }
    //     console.log(`Found order for fill.cloid: ${fill.oid}`, fill);
    //     // e.g. USDT-USDC sell limit order fill (sell USDT for USDC)
    //     // {
    //     //   coin: '@166',
    //     //   px: '0.99987',
    //     //   sz: '12.0',
    //     //   side: 'A',
    //     //   time: 1762442654786,
    //     //   startPosition: '20.75879498',
    //     //   dir: 'Sell',
    //     //   closedPnl: '-0.00266345',
    //     //   hash: '0x12bac8ba533cb3641434042ef5f8990207c6009fee3fd236b683740d12308d4e',
    //     //   oid: 225184674691,
    //     //   crossed: false,
    //     //   fee: '0.00095987',
    //     //   tid: 854069469806140,
    //     //   feeToken: 'USDC',
    //     //   twapId: null
    //     // }
    //   }
    });
    // For some reason, without the second allMids subscription set up below, the first one above
    // doesn't log anything???
    await subsClient.allMids(() => {
    //   console.log("Received new all mids:", data);
    });
    console.log("Set up subscriptions");

    // Setup:
    // - Load all user fills from Hyperliquid API: https://nktkas.gitbook.io/hyperliquid/api-reference/subscription-methods/userfills
    // For all orders with status PENDING_BRIDGE_TO_HYPEREVM, check if transfer has completed to HyperEVM, and if
    // it has then call _depositToHypercoreAndPlaceOrder(). Save the order with status PENDING_SWAP.
    // For all orders with status PENDING_SWAP, check if order has been filled, and if it has then call
    // _withdrawToHyperevm() and save order with status PENDING_WITHDRAWAL_TO_DESTINATION_CHAIN.
    // For all orders PENDING_BRIDGE_TO_DESTINATION_CHAIN, check if HyperEVM balance is sufficient and then
    // initiate CCTP/OFT transfer to destination chain, and then delete order.
    // this._bridgeToEvm()
  }

  private async _depositToHypercoreAndPlaceOrder(rebalanceRoute: RebalanceRoute) {
    // Maybe just call API
    const exchangeClient = new hl.ExchangeClient({
        transport: new hl.HttpTransport(),
        wallet: ethers.Wallet.fromMnemonic(process.env.MNEMONIC)
      });
      const cloid = await this._redisGetNextCloid();
      console.log(`Placing order with cloid: ${cloid}`);
      const spotMarketMeta = this.spotMarketMeta["USDT-USDC"];
      try {
        const result = await exchangeClient.order({
            orders: [{
              a: 10000 + spotMarketMeta.index, // Asset index + spot asset index prefix
              b: false, // Buy side (if true, buys quote asset else sells quote asset for base asset)
              p: "0.999", // Price
              s: spotMarketMeta.minimumOrderSize.toString(), // Size
              r: false, // Reduce only
              t: { limit: { tif: "Gtc" } },
              c: cloid
            }],
            grouping: "na"
          });
          console.log(`Order result: ${JSON.stringify(result)}`);  
          await this._redisCreateOrder(cloid, STATUS.PENDING_SWAP, rebalanceRoute);
      } catch (error: unknown) {
        if (error instanceof hl.ApiRequestError) {
          console.error(`API request error with status ${JSON.stringify(error.response)}`, error);
        } else if (error instanceof hl.TransportError) {
          console.error("Transport error", error);
        }  else {
          console.error("Unknown error", error);
        }
      }
  }

  private _withdrawToHyperevm() {
    // TODO
    //   this.hyperliquidHelper.withdrawToHyperevm(
    //     toHyperEvmAddress(rebalanceRoute.destinationToken),
    //     // Figure out how many tokens we received on core after the order settled:
    //     toUint64(rebalanceRoute.amount),
    //     this.user
    //   )
  }

  private _bridgeToEvm() {
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
  }

  getPendingRebalances(): Promise<RebalanceRoute[]> {
    return Promise.resolve([]);
  }

  /** ****************************************************
   *
   * REDIS HELPER FUNCTIONS
   *
   ****************************************************/

  async _redisGetOrderStatusKey(status: STATUS): Promise<string> {
    let orderStatusKey: string;
    switch (status) {
      case STATUS.PENDING_BRIDGE_TO_HYPEREVM:
        orderStatusKey = this.REDIS_KEY_PENDING_BRIDGE_TO_HYPEREVM;
        break;
      case STATUS.PENDING_SWAP:
        orderStatusKey = this.REDIS_KEY_PENDING_SWAP;
        break;
      case STATUS.PENDING_BRIDGE_TO_DESTINATION_CHAIN:
        orderStatusKey = this.REDIS_KEY_PENDING_BRIDGE_TO_DESTINATION_CHAIN;
        break;
      default:
        throw new Error(`Invalid status: ${status}`);
    }
    return orderStatusKey;
  }

  async _redisGetNextCloid(): Promise<string> {
    // Increment and get the latest nonce from Redis:
    const nonce = await this.redisCache.incr(`${this.REDIS_PREFIX}:${this.REDIS_KEY_LATEST_NONCE}`);

    return ethers.utils.hexZeroPad(ethers.utils.hexValue(nonce), 16);
  }

  async _redisGetOrder(oid: number): Promise<{ status: STATUS; rebalanceRoute: RebalanceRoute } | undefined> {
    const orderKey = `${this.REDIS_KEY_ORDER}:${oid}`;
    const order = await this.redisCache.get<string>(orderKey);
    if (!order) {
      return undefined;
    }
    const orderParsed = JSON.parse(order) as { status: STATUS; rebalanceRoute: RebalanceRoute };
    return orderParsed;
  }

  async _redisCreateOrder(cloid: string, status: STATUS, rebalanceRoute: RebalanceRoute): Promise<void> {
    const orderStatusKey = await this._redisGetOrderStatusKey(status);

    // Create a new order in Redis.
    const newOrderKey = `${this.REDIS_KEY_ORDER}:${cloid}`;
    await Promise.all([
      this.redisCache.set(
        newOrderKey,
        JSON.stringify({
          status,
          rebalanceRoute,
        })
      ),
      this.redisCache.sAdd(orderStatusKey, cloid.toString()),
    ]);
    console.log(`Saved new order in redis with key: ${newOrderKey}`);
    console.log(`Added order to status set: ${orderStatusKey}`);
  }

  async _redisUpdateOrderStatus(nonce: number, oldStatus: STATUS, status: STATUS): Promise<void> {
    const oldOrderStatusKey = await this._redisGetOrderStatusKey(oldStatus);
    const newOrderStatusKey = await this._redisGetOrderStatusKey(status);
    await Promise.all([
      this.redisCache.sRem(oldOrderStatusKey, nonce.toString()),
      this.redisCache.sAdd(newOrderStatusKey, nonce.toString()),
    ]);
  }

  async _redisGetPendingOrderNonces(): Promise<number[]> {
    // Add all pending order nonces for all statuses to a single set and return the set.
    const pendingOrderNonces = await Promise.all([
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_BRIDGE_TO_HYPEREVM),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_SWAP),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_BRIDGE_TO_DESTINATION_CHAIN),
    ]);
    return pendingOrderNonces.flat().map((nonce) => parseInt(nonce));
  }

  async _redisDeleteOrder(nonce: number, status: STATUS): Promise<void> {
    const orderKey = `${this.REDIS_KEY_ORDER}:${nonce}`;
    await this.redisCache.del(orderKey);
    const orderStatusKey = await this._redisGetOrderStatusKey(status);
    await this.redisCache.sRem(orderStatusKey, nonce.toString());
  }
}
