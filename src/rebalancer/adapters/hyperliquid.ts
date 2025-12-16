import { RedisCache } from "../../caching/RedisCache";
import { MultiCallerClient } from "../../clients";
import {
  BigNumber,
  blockExplorerLink,
  CHAIN_IDs,
  Contract,
  ConvertDecimals,
  ERC20,
  ethers,
  EvmAddress,
  fromWei,
  getBlockForTimestamp,
  getProvider,
  getRedisCache,
  paginatedEventQuery,
  Provider,
  Signer,
  toBNWei,
  TOKEN_SYMBOLS_MAP,
  winston,
} from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";
import * as hl from "@nktkas/hyperliquid";
import { RebalancerConfig } from "../RebalancerConfig";

// TODO: Clear out local database and order these from earliest stage to latest stage.
// enum STATUS {
//   PENDING_BRIDGE_TO_HYPEREVM,
//   PENDING_DEPOSIT_TO_HYPERCORE,
//   PENDING_SWAP,
//   PENDING_WITHDRAWAL_FROM_HYPERCORE,
//   PENDING_BRIDGE_TO_DESTINATION_CHAIN,
// }
enum STATUS {
  PENDING_BRIDGE_TO_HYPEREVM,
  PENDING_SWAP,
  PENDING_BRIDGE_TO_DESTINATION_CHAIN,
  PENDING_WITHDRAWAL_FROM_HYPERCORE,
  PENDING_DEPOSIT_TO_HYPERCORE,
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
  tokenIndex: number;
  evmDecimals: number;
  coreDecimals: number;
}

// Maximum number of decimal places for a price in a Hyperliquid order.
const MAX_DECIMAL_PLACES_HL_ORDER_PX = 5;

// This adapter can be used to swap stables in Hyperliquid. This is preferable to swapping on source or destination
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
  REDIS_KEY_PENDING_WITHDRAWAL_FROM_HYPERCORE = this.REDIS_PREFIX + "pending-withdrawal-from-hypercore";

  // The following two tables keep track of pending transfers. The exact amounts expected to be received are important
  // so we can correctly update order statuses.
  REDIS_KEY_BRIDGE_TO_HYPEREVM = this.REDIS_PREFIX + "bridge-to-hyperevm";
  REDIS_KEY_BRIDGE_FROM_HYPEREVM = this.REDIS_PREFIX + "bridge-from-hyperevm";
  REDIS_KEY_BRIDGE_FROM_HYPERCORE = this.REDIS_PREFIX + "bridge-from-hypercore";

  // This table associates HL cloid's with rebalance route information, so we can correctly progress the pending order
  // through the EVM -> HL -> EVM lifecycle.
  REDIS_KEY_PENDING_ORDER = this.REDIS_PREFIX + "pending-order";

  // This table associates HL cloid's with the amount filled, so we can figure out how much to withdraw.
  REDIS_KEY_FILLS = this.REDIS_PREFIX + "fills";

  private baseSignerAddress: EvmAddress;

  // @dev Every market is saved in here twice, where the base and quote asset are reversed in the dictionary key
  // and the isBuy is flipped.
  private spotMarketMeta: { [name: string]: SPOT_MARKET_META } = {
    "USDT-USDC": {
      index: 166,
      quoteAssetIndex: 268,
      baseAssetIndex: 0,
      quoteAssetName: "USDT",
      baseAssetName: "USDC",
      minimumOrderSize: 10,
      isBuy: false,
    },
    "USDC-USDT": {
      index: 166,
      quoteAssetIndex: 268,
      baseAssetIndex: 0,
      quoteAssetName: "USDT",
      baseAssetName: "USDC",
      minimumOrderSize: 10,
      isBuy: true,
    },
  };

  private tokenMeta: { [symbol: string]: TOKEN_META } = {
    USDT: {
      evmSystemAddress: EvmAddress.from("0x200000000000000000000000000000000000010C"),
      tokenIndex: 268,
      evmDecimals: 6,
      coreDecimals: 8,
    },
    USDC: {
      evmSystemAddress: EvmAddress.from("0x2000000000000000000000000000000000000000"),
      tokenIndex: 0,
      evmDecimals: 6,
      coreDecimals: 8,
    },
  };

  private availableRoutes: RebalanceRoute[];

  private multicallerClient: MultiCallerClient;

  private providers: { [chainId: number]: Provider };

  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {
    // TODO
  }

  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.redisCache = (await getRedisCache()) as RedisCache;
    this.availableRoutes = _availableRoutes;
    this.multicallerClient = new MultiCallerClient(this.logger, this.config.multiCallChunkSize, this.baseSigner);

    for (const route of this.availableRoutes) {
      // Initialize a provider for the source chain and check if we have spot market data
      // and token data for that source token and destination token.
      const expectedName = `${route.sourceToken}-${route.destinationToken}`;
      if (!this.spotMarketMeta[expectedName]) {
        throw new Error(`Missing spotMarketMeta data for ${expectedName}`);
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

    const tokenMeta = this._getTokenMeta(rebalanceRoute.sourceToken);

    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });

    const spotClearingHouseState = await infoClient.spotClearinghouseState({ user: this.baseSignerAddress.toNative() });
    console.log("Spot clearing house state", spotClearingHouseState);

    const balanceInputToken = spotClearingHouseState.balances.find(
      (balance) => balance.coin === this._remapTokenSymbolToHlSymbol(rebalanceRoute.sourceToken)
    );
    if (!balanceInputToken) {
      console.error(`No balance found for input token: ${rebalanceRoute.sourceToken}`);
      return;
    }

    const availableBalance = toBNWei(balanceInputToken.total, tokenMeta.coreDecimals).sub(
      toBNWei(balanceInputToken.hold, tokenMeta.coreDecimals)
    );
    const availableBalanceEvmDecimals = ConvertDecimals(
      tokenMeta.coreDecimals,
      tokenMeta.evmDecimals
    )(availableBalance);
    if (availableBalanceEvmDecimals.lt(rebalanceRoute.maxAmountToTransfer)) {
      console.error(
        `Available balance for input token: ${
          rebalanceRoute.sourceToken
        } (${availableBalanceEvmDecimals.toString()}) is less than max amount to transfer: ${rebalanceRoute.maxAmountToTransfer.toString()}`
      );
      return;
    }

    // Fetch latest price for the market we're going to place an order for:
    const spotMarketMeta = this._getSpotMarketMetaForRoute(rebalanceRoute.sourceToken, rebalanceRoute.destinationToken);
    const spotMarketData = await infoClient.spotMetaAndAssetCtxs();
    const tokenData = spotMarketData[1].find((market) => market.coin === `@${spotMarketMeta.index}`);
    if (!tokenData) {
      throw new Error(`No token data found for spot market: ${spotMarketMeta.index}`);
    }
    const latestPrice = await this._getLatestPrice(
      rebalanceRoute.sourceToken,
      rebalanceRoute.destinationToken,
      spotMarketMeta.isBuy
    );
    console.log(`Latest price: ${latestPrice}`);

    // Check for open orders and available balance. If no open orders matching desired CLOID and available balance
    // is sufficient, then place order.

    const cloid = await this._redisGetNextCloid();
    console.log(`Placing order with cloid: ${cloid}`);
    await this._placeLimitOrder(cloid, rebalanceRoute, latestPrice);
    await this._redisCreateOrder(cloid, STATUS.PENDING_SWAP, rebalanceRoute);
  }

  // TODO: Pass in from and to timestamps here to make sure updates across all chains are in sync.
  async updateRebalanceStatuses(): Promise<void> {
    // The most important thing we want this function to do so is to update state such that getPendingRebalances()
    // returns the correct virtual balances:
    // - Get all open orders and user fills from HL API.
    // - Load all CCTP MintAndWithdraw events across all chains for user:
    // - For all PENDING_BRIDGE_TO_HYPEREVM orders and PENDING_BRIDGE_TO_DESTINATION_CHAIN orders,
    //   check if there is a matching MintAndWithdraw event.
    //    - If there is a matching event, then we have some extra balance on the destination chain that we need to account for so
    //      we should add negative virtual balances to cancel it out.
    // - For all PENDING_WITHDRAWAL_FROM_HYPERCORE orders, check if there is a matching Transfer event
    //    - If there is, then we have too much balance on HyperEVM that we need to account for so we should add
    //      negative virtual balances to cancel it out.

    // How to update order statuses and place new transactions:
    // PENDING_BRIDGE_TO_HYPEREVM:
    // - For any orders with this status and a matching MintAndWithdraw event, update the order to
    //   PENDING_DEPOSIT_TO_HYPERCORE and initiate a deposit into Hypercore.
    // PENDING_SWAP:
    // - For any orders with this status, check if there is an open order order or a user fill matching this oid.
    //   If there is none, then the order must have been cancelled so we need to replace it with the same OID.
    //   If there is a user fill, update the order status to PENDING_WITHDRAWAL_FROM_HYPERCORE and initiate a withdrawal from Hypercore.
    // - For any orders with this status that have been outstanding for > N hours, cancel them and replace them.
    // PENDING_BRIDGE_TO_DESTINATION_CHAIN:
    // - For any orders with this status and a matching MintAndWithdraw event, delete the order from Redis.
    // PENDING_DEPOSIT_TO_HYPERCORE:
    // - For any orders with this status and a matching Transfer event, change the order status to PENDING_SWAP
    // PENDING_WITHDRAWAL_FROM_HYPERCORE:
    // - For any orders with this status and a matching Transfer event, update the order status to PENDING_BRIDGE_TO_DESTINATION_CHAIN
    //   or delete it if HyperEVM is the final destination chain. We can determine what to do based on the saved
    //   RebalanceRoute information in Redis.

    // Evaluate all statuses from "latest stage" to earliest:
    // i.e. PENDING_BRIDGE_TO_DESTINATION_CHAIN -> PENDING_WITHDRAWAL_FROM_HYPERCORE -> PENDING_SWAP -> PENDING_DEPOSIT_TO_HYPERCORE -> PENDING_BRIDGE_TO_HYPEREVM

    const pendingBridgeToDestinationChain = await this._redisGetPendingBridgeToDestinationChain();
    console.log("Orders pending bridge to destination chain", pendingBridgeToDestinationChain);

    // Figure out what time we last received an update so we can get all updates since then:
    const lastPollEnd = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7; // 7 days ago
    const provider = await getProvider(CHAIN_IDs.HYPEREVM);
    const fromBlock = await getBlockForTimestamp(this.logger, CHAIN_IDs.HYPEREVM, lastPollEnd);
    const toBlock = await provider.getBlock("latest");

    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const openOrders = await infoClient.openOrders({ user: this.baseSignerAddress.toNative() });
    console.log("Open orders", openOrders);

    // Refactor the following to be dynamic and query events for all ERC20's that are involved in
    // rebalance routes:
    const USDC = new Contract(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.HYPEREVM], ERC20.abi, provider);
    const CORE_DEPOSIT_WALLET = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24";
    const USDC_withdrawalsToHypercore = await paginatedEventQuery(
      USDC,
      USDC.filters.Transfer(CORE_DEPOSIT_WALLET, this.baseSignerAddress.toNative()),
      { from: fromBlock, to: toBlock.number, maxLookBack: this.config.maxBlockLookBack[CHAIN_IDs.HYPEREVM] }
    );
    console.log(
      `Found ${USDC_withdrawalsToHypercore.length} USDC withdrawals from Hypercore to user between blocks ${fromBlock} and ${toBlock.number}`
    );

    const USDT = new Contract(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.HYPEREVM], ERC20.abi, provider);
    const USDT_withdrawalsToHypercore = await paginatedEventQuery(
      USDT,
      USDT.filters.Transfer(this.tokenMeta["USDT"].evmSystemAddress.toNative(), this.baseSignerAddress.toNative()),
      { from: fromBlock, to: toBlock.number, maxLookBack: this.config.maxBlockLookBack[CHAIN_IDs.HYPEREVM] }
    );
    console.log(
      `Found ${USDT_withdrawalsToHypercore.length} USDT withdrawals from Hypercore to user between blocks ${fromBlock} and ${toBlock.number}`
    );
    // End refactor.

    const pendingWithdrawals = await this._redisGetPendingWithdrawals();
    console.log("Orders pending withdrawal from Hypercore", pendingWithdrawals);
    for (const cloid of pendingWithdrawals) {
      // Check if transfer landed on EVM from EvmSystem address to user, and if so, then either delete the order
      // because it has completed or update the order status to PENDING_BRIDGE_TO_DESTINATION_CHAIN and initiate
      // a bridge to destination chain.
      const orderDetails = await this._redisGetOrderDetails(cloid);
      console.log(`Final destination for order with cloid ${cloid}!`, orderDetails.destinationChain);

      const matchingFill = await this._getMatchingFillForCloid(cloid, lastPollEnd * 1000);
      if (!matchingFill) {
        throw new Error(`No matching fill found for cloid ${cloid} that has status PENDING_WITHDRAWAL_FROM_HYPERCORE`);
      }

      const destinationTokenMeta = this._getTokenMeta(orderDetails.destinationToken);
      const expectedAmountToReceive = ConvertDecimals(
        destinationTokenMeta.coreDecimals,
        destinationTokenMeta.evmDecimals
      )(matchingFill.amountToWithdraw);
      console.log(`Trying to find ERC20 transfer matching withdrawal for amount ${expectedAmountToReceive.toString()}`);
      const transferMatchingWithdrawal = (
        orderDetails.destinationToken === "USDC" ? USDC_withdrawalsToHypercore : USDT_withdrawalsToHypercore
      ).find((transfer) => expectedAmountToReceive.toString() === transfer.args.value.toString());
      if (transferMatchingWithdrawal) {
        console.log(`Found ERC20 transfer matching withdrawal for cloid ${cloid}!`, transferMatchingWithdrawal);
        if (orderDetails.destinationChain === CHAIN_IDs.HYPEREVM) {
          console.log(`Deleting order with cloid ${cloid} because it has completed!`);
          await this._redisDeleteOrder(cloid, STATUS.PENDING_WITHDRAWAL_FROM_HYPERCORE);
        } else {
          console.log(`Sending order with cloid ${cloid} to final destination chain ${orderDetails.destinationChain}!`);
          await this._redisUpdateOrderStatus(
            cloid,
            STATUS.PENDING_WITHDRAWAL_FROM_HYPERCORE,
            STATUS.PENDING_BRIDGE_TO_DESTINATION_CHAIN
          );
        }
      } else {
        console.log(`No ERC20 transfer matching withdrawal for cloid ${cloid}!`);
      }

      // TODO: Fetch all transfers on HyperEVM from system address to user, and if it exists update the order status:
      // example https://hyperevmscan.io/tx/0x13963f183a1356851617435f836503b58ce53dd93afae22412efee2b40985446
      // if (orderDetails.destinationChain === CHAIN_IDs.HYPEREVM) {
      // For USDC: transfers on HyperEVM come from Core deposit wallet: https://hyperevmscan.io/tx/0xadf4b1d14d92dedc6417b9c20c1a1dab0b2ff8a73cfffb77d5c0a67f22258dc2
      // For other ERC20's it should come from system address
      // }
    }

    const pendingSwaps = await this._redisGetPendingSwaps();
    for (const cloid of pendingSwaps) {
      const matchingFill = await this._getMatchingFillForCloid(cloid, lastPollEnd * 1000);
      const matchingOpenOrder = openOrders.find((order) => order.cloid === cloid);
      if (matchingFill) {
        console.log(`Open order for cloid ${cloid} filled! Proceeding to withdraw from Hypercore.`);

        // Issue a withdrawal from HL now:
        const existingOrder = await this._redisGetOrderDetails(cloid);
        console.log(
          `Withdrawing ${matchingFill.amountToWithdraw.toString()} ${
            existingOrder.destinationToken
          } from Hypercore to HyperEVM.`
        );
        await this._withdrawToHyperevm(existingOrder.destinationToken, matchingFill.amountToWithdraw);
        await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_SWAP, STATUS.PENDING_WITHDRAWAL_FROM_HYPERCORE);
      } else if (!matchingOpenOrder) {
        const existingOrder = await this._redisGetOrderDetails(cloid);
        const spotMarketMeta = this._getSpotMarketMetaForRoute(
          existingOrder.sourceToken,
          existingOrder.destinationToken
        );
        const latestPrice = await this._getLatestPrice(
          existingOrder.sourceToken,
          existingOrder.destinationToken,
          spotMarketMeta.isBuy
        );
        console.log(
          `Missing order for cloid ${cloid}, replacing the order with new price ${latestPrice}`,
          existingOrder
        );
        await this._placeLimitOrder(cloid, existingOrder, latestPrice);
      } else {
        console.log("Order is still unfilled", matchingOpenOrder);
      }
      // See if cloid matches with an open order and user fill
      // If it has a user fill, then update its order status to next state:
      // If it doesn't have a user fill AND doesn't have an open order, then replace its order.
    }
  }

  private _getSpotMarketMetaForRoute(sourceToken: string, destinationToken: string): SPOT_MARKET_META {
    const spotMarketName = `${sourceToken}-${destinationToken}`;
    const spotMarketMeta = this.spotMarketMeta[spotMarketName];
    if (!spotMarketMeta) {
      throw new Error(`No spot market meta found for route: ${spotMarketName}`);
    }
    return spotMarketMeta;
  }

  private async _getMatchingFillForCloid(
    cloid: string,
    startTime: number
  ): Promise<{ details: any; amountToWithdraw: BigNumber } | undefined> {
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const userFills = await infoClient.userFillsByTime({
      user: this.baseSignerAddress.toNative(),
      startTime,
    });

    const matchingFill = userFills.find((fill) => fill.cloid === cloid);
    if (!matchingFill) {
      return undefined;
    }
    const existingOrder = await this._redisGetOrderDetails(cloid);
    const destinationTokenMeta = this._getTokenMeta(existingOrder.destinationToken);

    // If fill was a buy, then received amount is denominated in base asset, same as sz.
    // If fill was a sell, then received amount is denominated in quote asset, so receivedAmount = px * sz.
    let amountToWithdraw: BigNumber;
    if (matchingFill.dir === "Buy") {
      amountToWithdraw = toBNWei(matchingFill.sz, destinationTokenMeta.coreDecimals);
    } else {
      amountToWithdraw = toBNWei(matchingFill.sz, destinationTokenMeta.coreDecimals)
        .mul(toBNWei(matchingFill.px, MAX_DECIMAL_PLACES_HL_ORDER_PX))
        .div(10 ** MAX_DECIMAL_PLACES_HL_ORDER_PX);
    }

    return { details: matchingFill, amountToWithdraw };
  }

  private async _getLatestPrice(sourceToken: string, destinationToken: string, isBuy: boolean): Promise<string> {
    if (process.env.PX_OVERRIDE) {
      return process.env.PX_OVERRIDE;
    }
    // TODO: Use L2 book endpoint to get the best price using orderbook liquidity that would cover our size:
    // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#l2-book-snapshot
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const spotMarketData = await infoClient.spotMetaAndAssetCtxs();
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const tokenData = spotMarketData[1].find((market) => market.coin === `@${spotMarketMeta.index}`);
    if (!tokenData) {
      throw new Error(`No token data found for spot market: ${spotMarketMeta.index}`);
    }

    // Add 2bps to the mid price to increase probability of execution.
    // If direction is a Buy, we'll increase the price otherwise we'll decrease.
    const midPricePlus = isBuy
      ? toBNWei(tokenData.midPx, MAX_DECIMAL_PLACES_HL_ORDER_PX).mul(10002).div(10000)
      : toBNWei(tokenData.midPx, MAX_DECIMAL_PLACES_HL_ORDER_PX).mul(9998).div(10000);
    // TODO: Use markPx or midPx? Add a discount/premium to increase prob. of execution?

    // Price can have up to 5 significant figures so if the price is less than 1, then there can
    // be 5 decimal places. If the price starts with a 1, which is realistically the highest it will be for a
    // stablecoin swap, then there can be be 4 decimal places.
    const fullPrice = Number(fromWei(midPricePlus, MAX_DECIMAL_PLACES_HL_ORDER_PX));
    console.log(`_getLatestPrice: fullPrice: ${fullPrice} given midPricePlus: ${midPricePlus.toString()}`);
    return fullPrice.toFixed(fullPrice < 1 ? MAX_DECIMAL_PLACES_HL_ORDER_PX : 4);
  }

  private _getTokenMeta(token: string): TOKEN_META {
    const tokenMeta = this.tokenMeta[token];
    if (!tokenMeta) {
      throw new Error(`No token meta found for token: ${token}`);
    }
    return tokenMeta;
  }

  private _remapTokenSymbolToHlSymbol(token: string): string {
    switch (token) {
      case "USDT":
        return "USDT0";
      default:
        return token;
    }
  }

  private async _placeLimitOrder(cloid: string, rebalanceRoute: RebalanceRoute, px: string): Promise<void> {
    const { sourceToken, destinationToken } = rebalanceRoute;
    console.log(`_placeLimitOrder: placing new order for cloid ${cloid}`);
    // rebalanceRoute represents an order that we need to make on HL.
    // - TODO: How to set size accurately using rebalanceRoute? Is it equal to expected price * inAmount? or outAmount / expected price?

    // Place order:
    const exchangeClient = new hl.ExchangeClient({
      transport: new hl.HttpTransport(),
      wallet: ethers.Wallet.fromMnemonic(process.env.MNEMONIC),
    });
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);

    const destinationTokenMeta = this._getTokenMeta(destinationToken);
    const sourceTokenMeta = this._getTokenMeta(sourceToken);

    // Determining sz:
    // - The rebalanceRoute.amount is the amount of source tokens that are depositing into HL. It should already be
    // adjusted upwards to pay for any expected fees. However, sz is always specified in the base asset and px is
    // base / quote asset (px * sz returns a value denominated in the quote asset).
    // - Therefore, if isBuy is "true" then we are buying the "sz" amount of base asset with "rebalanceRoute.amount"
    // of the quote asset. We need to solve for "sz" and rebalance.amount = sz * px.
    // - If isBuy is "false" then we are selling "sz" amount of base asset to obtain the quote asset. The rebalanceRoute.amount
    // is denominated in the base asset, so rebalance.amount can be simply set to sz.
    const sz = spotMarketMeta.isBuy
      ? rebalanceRoute.maxAmountToTransfer
          .mul(10 ** MAX_DECIMAL_PLACES_HL_ORDER_PX)
          .div(toBNWei(px, MAX_DECIMAL_PLACES_HL_ORDER_PX))
      : rebalanceRoute.maxAmountToTransfer;
    console.log(
      `_placeLimitOrder: sz: ${sz} given price ${px} and isBuy ${
        spotMarketMeta.isBuy
      } and maxAmountToTransfer ${rebalanceRoute.maxAmountToTransfer.toString()}`
    );
    const minimumOrderSize = toBNWei(
      spotMarketMeta.minimumOrderSize,
      spotMarketMeta.isBuy ? destinationTokenMeta.evmDecimals : sourceTokenMeta.evmDecimals
    );
    if (sz.lt(minimumOrderSize)) {
      throw new Error(`Order size ${sz.toString()} is less than minimum order size ${minimumOrderSize.toString()}`);
    }
    // sz is always in base units, so if we're buying the base unit then
    try {
      const orderDetails = {
        a: 10000 + spotMarketMeta.index, // Asset index + spot asset index prefix
        b: spotMarketMeta.isBuy, // Buy side (if true, buys quote asset else sells quote asset for base asset)
        p: px, // Price
        s: fromWei(sz, spotMarketMeta.isBuy ? destinationTokenMeta.evmDecimals : sourceTokenMeta.evmDecimals), // Size
        r: false, // Reduce only
        t: { limit: { tif: "Gtc" as const } },
        c: cloid,
      };
      console.log("_placeLimitOrder: Order details", orderDetails);
      const result = await exchangeClient.order({
        orders: [orderDetails],
        grouping: "na",
      });
      console.log("_placeLimitOrder: Order result", JSON.stringify(result, null, 2));
    } catch (error: unknown) {
      if (error instanceof hl.ApiRequestError) {
        console.error(`API request error with status ${JSON.stringify(error.response)}`, error);
      } else if (error instanceof hl.TransportError) {
        console.error("Transport error", error);
      } else {
        console.error("Unknown error", error);
      }
    }
  }

  private async _withdrawToHyperevm(destinationToken: string, amountToWithdrawCorePrecision: BigNumber): Promise<void> {
    const { HYPEREVM } = CHAIN_IDs;
    // CoreWriter contract on EVM that can be used to interact with Hypercore.
    const CORE_WRITER_EVM_ADDRESS = "0x3333333333333333333333333333333333333333";
    // CoreWriter exposes a single function that charges 20k gas to send an instruction on Hypercore.
    const CORE_WRITER_ABI = ["function sendRawAction(bytes)"];
    // To transfer Core balance, a 'spotSend' action must be specified in the payload to sendRawAction:
    const SPOT_SEND_PREFIX_BYTES = ethers.utils.hexlify([
      1, // byte 0: version, must be 1
      // bytes 1-3: unique action index as described here:
      // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore#corewriter-contract
      0,
      0,
      6, // action index of spotSend is 6, so bytes 1-3 are 006
    ]);
    const tokenMeta = this._getTokenMeta(destinationToken);
    const provider = await getProvider(HYPEREVM);
    const connectedSigner = this.baseSigner.connect(provider);

    const coreWriterContract = new Contract(CORE_WRITER_EVM_ADDRESS, CORE_WRITER_ABI, connectedSigner);
    const spotSendArgBytes_withdrawFromCore = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint64", "uint64"],
      [tokenMeta.evmSystemAddress.toNative(), tokenMeta.tokenIndex, amountToWithdrawCorePrecision]
    );

    // @dev costs 20k gas on HyperEVM
    const spotSendBytes = ethers.utils.hexlify(
      ethers.utils.concat([SPOT_SEND_PREFIX_BYTES, spotSendArgBytes_withdrawFromCore])
    );

    const amountToWithdraw = fromWei(amountToWithdrawCorePrecision, tokenMeta.coreDecimals);
    console.log(`Withdrawing ${amountToWithdraw} ${destinationToken} from Core to Evm`, spotSendBytes);

    // Note: I'd like this to work via the multicaller client or runTransaction but the .wait() seems to fail.
    // Note: If sending multicaller client txn, unpermissioned:false and nonMulticall:true must be set.
    const txn = await coreWriterContract.sendRawAction(spotSendBytes);
    console.log(
      `Withdrew ${amountToWithdraw} ${destinationToken} from Hypercore to HyperEVM`,
      blockExplorerLink(txn.hash, HYPEREVM)
    );
  }

  getPendingRebalances(): Promise<RebalanceRoute[]> {
    return Promise.resolve([]);
  }

  /** ****************************************************
   *
   * REDIS HELPER FUNCTIONS
   *
   ****************************************************/

  _redisGetOrderStatusKey(status: STATUS): string {
    let orderStatusKey: string;
    switch (status) {
      case STATUS.PENDING_BRIDGE_TO_HYPEREVM:
        orderStatusKey = this.REDIS_KEY_PENDING_BRIDGE_TO_HYPEREVM;
        break;
      case STATUS.PENDING_SWAP:
        orderStatusKey = this.REDIS_KEY_PENDING_SWAP;
        break;
      case STATUS.PENDING_WITHDRAWAL_FROM_HYPERCORE:
        orderStatusKey = this.REDIS_KEY_PENDING_WITHDRAWAL_FROM_HYPERCORE;
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

  async _redisCreateOrder(cloid: string, status: STATUS, rebalanceRoute: RebalanceRoute): Promise<void> {
    const orderStatusKey = this._redisGetOrderStatusKey(status);
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;

    console.log(`_redisCreateOrder: Saving order to status set: ${orderStatusKey}`);
    console.log(`_redisCreateOrder: Saving new order details under key ${orderDetailsKey}`, rebalanceRoute);

    // Create a new order in Redis.
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

  async _redisGetOrderDetails(cloid: string): Promise<RebalanceRoute> {
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

  async _redisUpdateOrderStatus(cloid: string, oldStatus: STATUS, status: STATUS): Promise<void> {
    const oldOrderStatusKey = this._redisGetOrderStatusKey(oldStatus);
    const newOrderStatusKey = this._redisGetOrderStatusKey(status);
    const result = await Promise.all([
      this.redisCache.sRem(oldOrderStatusKey, cloid),
      this.redisCache.sAdd(newOrderStatusKey, cloid),
    ]);
    console.log(`Updated order status from ${oldOrderStatusKey} to ${newOrderStatusKey}`, result);
  }

  async _redisGetPendingSwaps(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_SWAP);
    return sMembers;
  }

  async _redisGetPendingWithdrawals(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_WITHDRAWAL_FROM_HYPERCORE);
    return sMembers;
  }

  async _redisGetPendingBridgeToDestinationChain(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_BRIDGE_TO_DESTINATION_CHAIN);
    return sMembers;
  }

  async _redisDeleteOrder(cloid: string, currentStatus: STATUS): Promise<void> {
    const orderStatusKey = this._redisGetOrderStatusKey(currentStatus);
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;
    const result = await Promise.all([
      this.redisCache.sRem(orderStatusKey, cloid),
      this.redisCache.del(orderDetailsKey),
    ]);
    console.log(`Deleted order details under key ${orderDetailsKey} and from status table ${orderStatusKey}`, result);
  }
}
