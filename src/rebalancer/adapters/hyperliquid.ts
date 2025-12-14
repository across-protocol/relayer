import { RedisCache } from "../../caching/RedisCache";
import { BigNumber, ethers, EvmAddress, getRedisCache, Signer} from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";
import * as hl from "@nktkas/hyperliquid";

enum STATUS {
  PENDING_BRIDGE_TO_HYPEREVM,
  PENDING_SWAP,
  PENDING_BRIDGE_TO_DESTINATION_CHAIN,
  // Do we need the two following statuses? Is it possible to even track when a deposit to/from Hypercore has completed?
  // PENDING_DEPOSIT_TO_HYPERCORE,
  // PENDING_WITHDRAWAL_FROM_HYPERCORE,
}

interface SPOT_MARKET_META {
    index: number;
    quoteAssetIndex: number;
    baseAssetIndex: number;
    baseAssetName: string;
    quoteAssetName: string;
    minimumOrderSize: number;
    isBuy: boolean;
}

interface TOKEN_META {
  evmSystemAddress: EvmAddress;
}

// This adapter can be used to swap stables in Hyperliquid. This is preferablet to swapping on source or destination
// prior to bridging because most chains have high fees for stablecoin swaps on DEX's, whereas bridging from OFT/CCTP
// into HyperEVM is free (or 0.01% for fast transfers) and then swapping on Hyperliquid is very cheap compared to DEX's.
// We should continually re-evaluate whether hyperliquid stablecoin swaps are indeed the cheapest option.
export class HyperliquidStablecoinSwapAdapter implements RebalancerAdapter {
  private redisCache: RedisCache;

  REDIS_PREFIX = "hyperliquid-stablecoin-swap:";
  // Key used to query latest cloid that uniquely identifies orders. Also used to set cloids when placing HL orders.
  REDIS_KEY_LATEST_NONCE = this.REDIS_PREFIX + "latest-nonce";
  // The following three keys map to Sets of order nonces where the order has the relevant status.
  REDIS_KEY_PENDING_BRIDGE_TO_HYPEREVM = this.REDIS_PREFIX + "pending-bridge-to-hyperliquid";
  REDIS_KEY_PENDING_SWAP = this.REDIS_PREFIX + "pending-swap";
  REDIS_KEY_PENDING_BRIDGE_TO_DESTINATION_CHAIN = this.REDIS_PREFIX + "pending-bridge-to-destination-chain";

  // The following two tables keep track of pending transfers. The exact amounts expected to be received are important
  // so we can correctly update order statuses.
  REDIS_KEY_BRIDGE_TO_HYPEREVM = this.REDIS_PREFIX + "bridge-to-hyperevm";
  REDIS_KEY_BRIDGE_FROM_HYPEREVM = this.REDIS_PREFIX + "bridge-from-hyperevm";
  REDIS_KEY_BRIDGE_FROM_HYPERCORE = this.REDIS_PREFIX + "bridge-from-hypercore";

  private baseSignerAddress: EvmAddress;

  // @dev Every market is saved in here twice, where the base and quote asset are reversed in the dictionary key
  // and the isBuy is flipped.
  private spotMarketMeta: { [name: string]: SPOT_MARKET_META } =  {
    "USDT-USDC": {
      index: 166,
      quoteAssetIndex: 268,
      baseAssetIndex: 0,
      quoteAssetName: "USDT",
      baseAssetName: "USDC",
      minimumOrderSize: 10,
      isBuy: false
    },
    "USDC-USDT": {
      index: 166,
      quoteAssetIndex: 268,
      baseAssetIndex: 0,
      quoteAssetName: "USDT",
      baseAssetName: "USDC",
      minimumOrderSize: 10,
      isBuy: true
    }
  }

  private tokenMeta: { [symbol: string]: TOKEN_META } = {
    "USDT0": {
      evmSystemAddress: EvmAddress.from("0x200000000000000000000000000000000000010c"),
    },
    "USDH": {
      evmSystemAddress: EvmAddress.from("0x2000000000000000000000000000000000000168"),
    },
    "USDC": {
      evmSystemAddress: EvmAddress.from("0x2000000000000000000000000000000000000000"),
    }
  }

  private availableRoutes: RebalanceRoute[];

  constructor(readonly baseSigner: Signer) {
    // TODO
  }

  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.redisCache = (await getRedisCache()) as RedisCache;
    this.availableRoutes = _availableRoutes;

    for (const route of this.availableRoutes) {
        // Initialize a provider for the source chain and check if we have spot market data
        // and token data for that source token and destination token.
        const expectedName = `${route.sourceToken}-${route.destinationToken}`;
        if (!this.spotMarketMeta[expectedName]) {
          throw new Error(`Missing spotMarketMeta data for ${expectedName}`)
        }
    }

    // Tasks:
    // - Check allowances and set them as needed.
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
    // If source token is not USDC, USDT, or USDH, throw.
    // If destination token is same as source token, throw.
    // If source token is USDH then throw if source chain is not HyperEVM.
    // If source chain is not HyperEVM, then initiate CCTP/OFT transfer to HyperEVM and save order
    //     with status PENDING_BRIDGE_TO_HYPEREVM. Save the transfer under BRIDGE_TO_HYPEREVM in order to correctly
    //     mark the order status.

    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const spotMarketData = await infoClient.spotMetaAndAssetCtxs();
    const marketData = spotMarketData[1].find((market) => market.coin === "@166");
    console.log(`Market data`, marketData);

    const openOrders = await infoClient.openOrders({ user: this.baseSignerAddress.toNative() });
    console.log(`Open orders`, openOrders);

    const spotClearingHouseState = await infoClient.spotClearinghouseState({ user: this.baseSignerAddress.toNative() });
    console.log(`Spot clearing house state`, spotClearingHouseState);

    // Check for open orders and available balance. If no open orders matching desired CLOID and available balance
    // is sufficient, then place order.

    await this._depositToHypercoreAndPlaceOrder(rebalanceRoute);

  }

  async updateRebalanceStatuses(): Promise<void> {
    // Figure out what time we last received an update so we can get all updates since then:
    const lastPollEnd = 0;

    const subsClient = new hl.SubscriptionClient({
      transport: new hl.WebSocketTransport(),
    });
    console.log(`Created new subscription client, ${subsClient.transport.socket.url}`);
    console.log(`Polling for user fills for user: ${this.baseSignerAddress.toNative()}`);
    // const sub1 = await subsClient.userFills({ user: this.baseSignerAddress.toNative() }, async (data) => {
    //   for (const fill of data.fills) {
    //     if (fill.time > lastPollEnd) {
    //         console.log("Received new user fills:", data);

    //         // TODO: Update order status now:
    //     }

    // //     // Find order for fill.cloid:
    // //     const order = await this._redisGetOrder(fill.oid);
    // //     if (!order) {
    // //       continue;
    // //     }
    // //     console.log(`Found order for fill.cloid: ${fill.oid}`, fill);
    // //     // e.g. USDT-USDC sell limit order fill (sell USDT for USDC)
    // //     // {
    // //     //   coin: '@166',
    // //     //   px: '0.99987',
    // //     //   sz: '12.0',
    // //     //   side: 'A',
    // //     //   time: 1762442654786,
    // //     //   startPosition: '20.75879498',
    // //     //   dir: 'Sell',
    // //     //   closedPnl: '-0.00266345',
    // //     //   hash: '0x12bac8ba533cb3641434042ef5f8990207c6009fee3fd236b683740d12308d4e',
    // //     //   oid: 225184674691,
    // //     //   crossed: false,
    // //     //   fee: '0.00095987',
    // //     //   tid: 854069469806140,
    // //     //   feeToken: 'USDC',
    // //     //   twapId: null
    // //     // }
    //   }
    // });
    // await sub1.unsubscribe();

    const sub1 = await subsClient.userEvents({ user: this.baseSignerAddress.toNative() }, async (event) => {
      console.log(`Received new user event`, event)
    })
    // const sub1 = await subsClient.openOrders({ user: this.baseSignerAddress.toNative() }, async (order) => {
    //   console.log(`User open order`, order)
    // })
    const sub2 = await subsClient.orderUpdates({ user: this.baseSignerAddress.toNative() }, async (updates) => {
        for (const update of updates) {
                console.log(`Received an order update for order ${update.order.oid}`, update)
                
                // TODO: Update order status now:
        }
    });

    // This can be used to track deposits and withdrawals to/from Hypercore
    const sub4 = await subsClient.userNonFundingLedgerUpdates({ user: this.baseSignerAddress.toNative() }, async (data) => {
      for (const update of data.nonFundingLedgerUpdates) {
        // "deposits" from EVM to Core have type "spotTransfer" and the "user" initiating the transfer is the ERC20
        // system contract on Hyperevm
        if (update.delta.type === "spotTransfer" && this.tokenMeta[update.delta.token]?.evmSystemAddress.eq(EvmAddress.from(update.delta.user))) {
          console.log(`Received new deposit to Hypercore at time ${update.time}:`, update.delta);
        }

        // TODO: IDK What a USDC deposit from CoreDepositWallet looks like.
      }
    });
    // await sub4.unsubscribe();

      // For some reason, without the second allMids subscription set up below, the first one above
      // doesn't log anything???
      const sub3 = await subsClient.allMids(() => {
          //   console.log("Received new all mids:", data);
      });
      // await sub3.unsubscribe();

    // Check for on-chain events marking end of BRIDGE_FROM_HYPERCORE.
    // - We should be able to set the startBlock equal to the current time minus the lookback.
    
    // - TODO: I think this can all be done in a single "serverless" loop. As long as all order statuses are up to date
    //   before we send anymore rebalances, its fine, we won't duplicate send anything.
    // - Load all orders with status equal to PENDING_SWAPS and check if there are open orders matching the cloid.
    //     - If there are none, then either the order was filled or expired. If it was filled, then we should have enough
    //       balance of the destination token to withdraw back to EVM. If not, then we need to re-issue the order.
    //     - If the order was filled, then call _withdrawToHyperevm() and save order with status PENDING_WITHDRAWAL_TO_DESTINATION_CHAIN.
    //         - We should be able to read the amount to withdraw from the order object returned by the HL API.
    //     - Now, we have a potential race condition where the tokens are on the way to the destination chain (
    //       with a potential CCTP/OFT transfer also to undergo) but at some point, the order will settle but the
    //       order status will still be in a "pending" state. This means that this.getPendingRebalances() will still
    //       return this order. To solve this, we can set up a polling loop that checks for Transfers to the
    //       user on the destination chain and deletes the order from Redis as soon as one is found.
    //     - To correctly identify the pending bridge to destination chain, we'll need to save in Redis the
    //       amount that was withdrawn (and bridged) to the destination chain.
    // - Load all orders with status equal to PENDING_BRIDGE_TO_HYPEREVM and look for completed on-chain events
    //   matching saved data in the BRIDGE_TO_HYPEREVM redis table. Once the bridge to EVM settles, then switch status to PENDING_SWAP.
    // - Load all orders with status equal to PENDING_BRIDGE_TO_DESTINATION_CHAIN and look for completed on-chain events.

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
    // rebalanceRoute represents an order that we need to make on HL.
    // - TODO: How to set size accurately using rebalanceRoute? Is it equal to expected price * inAmount? or outAmount / expected price?

    // Deposit into Hypercore:

    // Place order:
      const exchangeClient = new hl.ExchangeClient({
          transport: new hl.HttpTransport(),
          wallet: ethers.Wallet.fromMnemonic(process.env.MNEMONIC)
      });
      const cloid = await this._redisGetNextCloid();
      console.log(`Placing order with cloid: ${cloid}`, rebalanceRoute);
      const expectedName = `${rebalanceRoute.sourceToken}-${rebalanceRoute.destinationToken}`;
      const spotMarketMeta = this.spotMarketMeta[expectedName];
      try {
        const result = await exchangeClient.order({
            orders: [{
              a: 10000 + spotMarketMeta.index, // Asset index + spot asset index prefix
              b: spotMarketMeta.isBuy, // Buy side (if true, buys quote asset else sells quote asset for base asset)
              p: "0.999", // Price
              s: spotMarketMeta.minimumOrderSize.toString(), // Size
              r: false, // Reduce only
              t: { limit: { tif: "Gtc" } },
              c: cloid
            }],
            grouping: "na"
          });
          console.log(`Order result: ${JSON.stringify(result)}`);  
          await this._redisCreateOrder(cloid, STATUS.PENDING_SWAP);
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

  async _redisGetBridgeToHyperevm(oid: number) {
    const orderKey = `${this.REDIS_KEY_BRIDGE_TO_HYPEREVM}:${oid}`;
    const order = await this.redisCache.get<string>(orderKey);
    if (!order) {
      return undefined;
    }
    const orderParsed = JSON.parse(order) as { expectedAmount: BigNumber };
    return orderParsed;
  }

  async _redisCreateOrder(cloid: string, status: STATUS): Promise<void> {
    const orderStatusKey = await this._redisGetOrderStatusKey(status);

    // Create a new order in Redis.
    const sAdd = await this.redisCache.sAdd(orderStatusKey, cloid.toString());
    console.log(`Added order ${sAdd} to status set: ${orderStatusKey}`);
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
    const orderStatusKey = await this._redisGetOrderStatusKey(status);
    await this.redisCache.sRem(orderStatusKey, nonce.toString());

    // Delete other order saved states
  }
}
