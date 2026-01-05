import { Binance, NewOrderSpot, OrderType } from "binance-api-node";
import {
  assert,
  BigNumber,
  BINANCE_NETWORKS,
  bnZero,
  Contract,
  ERC20,
  EventSearchConfig,
  EvmAddress,
  fromWei,
  getAccountCoins,
  getBinanceApiClient,
  getBinanceWithdrawals,
  getBlockForTimestamp,
  getNetworkName,
  getProvider,
  getRedisCache,
  paginatedEventQuery,
  Signer,
  toBNWei,
  TOKEN_SYMBOLS_MAP,
  winston,
} from "../../utils";
import { RebalanceRoute } from "../rebalancer";
import { RedisCache } from "../../caching/RedisCache";
import { BaseAdapter, OrderDetails } from "./baseAdapter";
import { AugmentedTransaction } from "../../clients";
import { RebalancerConfig } from "../RebalancerConfig";

enum STATUS {
  PENDING_DEPOSIT,
  PENDING_SWAP,
  PENDING_WITHDRAWAL,
}

interface SPOT_MARKET_META {
  symbol: string;
  baseAssetName: string;
  quoteAssetName: string;
  pxDecimals: number;
  szDecimals: number;
  minimumOrderSize: number;
  isBuy: boolean;
}

export class BinanceStablecoinSwapAdapter extends BaseAdapter {
  private binanceApiClient: Binance;
  private availableRoutes: RebalanceRoute[];

  REDIS_PREFIX = "binance-stablecoin-swap:";

  REDIS_KEY_PENDING_ORDER = this.REDIS_PREFIX + "pending-order";

  // Key used to query latest cloid that uniquely identifies orders. Also used to set cloids when placing HL orders.
  REDIS_KEY_LATEST_NONCE = this.REDIS_PREFIX + "latest-nonce";
  REDIS_KEY_PENDING_DEPOSIT = this.REDIS_PREFIX + "pending-deposit";
  REDIS_KEY_PENDING_SWAP = this.REDIS_PREFIX + "pending-swap";
  REDIS_KEY_PENDING_WITHDRAWAL = this.REDIS_PREFIX + "pending-withdrawal";

  private spotMarketMeta: { [name: string]: SPOT_MARKET_META } = {
    "USDT-USDC": {
      symbol: "USDCUSDT",
      baseAssetName: "USDC",
      quoteAssetName: "USDT",
      pxDecimals: 4, // PRICE_FILTER.tickSize: '0.00010000'
      szDecimals: 0, // SIZE_FILTER.stepSize: '1.00000000'
      isBuy: true,
      minimumOrderSize: 1,
    },
    "USDC-USDT": {
      symbol: "USDCUSDT",
      baseAssetName: "USDC",
      quoteAssetName: "USDT",
      pxDecimals: 4, // PRICE_FILTER.tickSize: '0.00010000'
      szDecimals: 0, // SIZE_FILTER.stepSize: '1.00000000'
      isBuy: false,
      minimumOrderSize: 1,
    },
  };
  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {
    super(logger);
  }
  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    this.redisCache = (await getRedisCache(this.logger)) as RedisCache;
    this.binanceApiClient = await getBinanceApiClient(process.env.BINANCE_API_BASE);
    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());

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
        `Source token ${sourceToken} not found in network ${
          BINANCE_NETWORKS[sourceChain]
        }, available networks: ${sourceCoin.networkList.map((network) => network.name).join(", ")}`
      );
      assert(
        destinationCoin.networkList.find((network) => network.name === BINANCE_NETWORKS[destinationChain]),
        `Destination token ${destinationToken} not found in network ${
          BINANCE_NETWORKS[destinationChain]
        }, available networks: ${destinationCoin.networkList.map((network) => network.name).join(", ")}`
      );
    }
    this.initialized = true;
  }
  async initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void> {
    this._assertInitialized();
    const { sourceChain, sourceToken, destinationToken, destinationChain } = rebalanceRoute;

    const accountCoins = await getAccountCoins(this.binanceApiClient);
    const destinationCoin = accountCoins.find((coin) => coin.symbol === destinationToken);
    const destinationNetwork = destinationCoin.networkList.find(
      (network) => network.name === BINANCE_NETWORKS[destinationChain]
    );

    // Convert input amount to destination amount and check its larger than minimum size
    const sourceTokenInfo = TOKEN_SYMBOLS_MAP[sourceToken];
    const minimumWithdrawalSize = toBNWei(destinationNetwork.withdrawMin, sourceTokenInfo.decimals);
    const maximumWithdrawalSize = toBNWei(destinationNetwork.withdrawMax, sourceTokenInfo.decimals);

    // TODO: The amount transferred here might produce dust due to the rounding required to meet the minimum order
    // tick size. We try not to precompute the size required to place an order here because the price might change
    // and the amount transferred in might be insufficient to place the order later on, producing more dust or an
    // error.
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const minimumOrderSize = toBNWei(spotMarketMeta.minimumOrderSize, sourceTokenInfo.decimals);

    assert(
      amountToTransfer.gte(minimumOrderSize),
      `amount to transfer ${amountToTransfer.toString()} is less than minimum order size ${minimumOrderSize.toString()}`
    );
    assert(
      amountToTransfer.gte(minimumWithdrawalSize),
      `amount to transfer ${amountToTransfer.toString()} is less than minimum withdrawal size ${minimumWithdrawalSize.toString()} on destination chain`
    );
    assert(
      amountToTransfer.lte(maximumWithdrawalSize),
      `amount to transfer ${amountToTransfer.toString()} is greater than maximum withdrawal size ${maximumWithdrawalSize.toString()} on destination chain`
    );

    // Deposit to Binance
    const depositAddress = await this.binanceApiClient.depositAddress({
      coin: sourceToken,
      network: BINANCE_NETWORKS[sourceChain],
    });
    const cloid = await this._redisGetNextCloid();
    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter.initializeRebalance",
      message: `Creating new order ${cloid} by first transferring ${amountToTransfer.toString()} ${sourceToken} into Binance from ${getNetworkName(
        sourceChain
      )} to deposit address ${depositAddress.address}`,
      destinationToken,
      destinationChain: getNetworkName(destinationChain),
    });

    const sourceProvider = await getProvider(sourceChain);
    const sourceAddress = sourceTokenInfo.addresses[sourceChain];
    const erc20 = new Contract(sourceAddress, ERC20.abi, this.baseSigner.connect(sourceProvider));
    const amountReadable = fromWei(amountToTransfer, sourceTokenInfo.decimals);
    const txn: AugmentedTransaction = {
      contract: erc20,
      method: "transfer",
      args: [depositAddress.address, amountToTransfer],
      chainId: sourceChain,
      nonMulticall: true,
      unpermissioned: false,
      message: `Deposited ${amountReadable} ${sourceToken} to Binance on chain ${getNetworkName(sourceChain)}`,
      mrkdwn: `Deposited ${amountReadable} ${sourceToken} to Binance on chain ${getNetworkName(sourceChain)}`,
    };
    await this._submitTransaction(txn);
    await this._redisCreateOrder(cloid, STATUS.PENDING_DEPOSIT, rebalanceRoute, amountToTransfer);
  }

  async sweepDust(): Promise<void> {
    // If there are no pending orders, then there might be dust to sweep.
    // However, we should be careful since this account is also used by primary relayer
  }

  async getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber> {
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    // Commission is denominated in percentage points.
    const tradeFeePct = (await this.binanceApiClient.tradeFee()).find(
      (fee) => fee.symbol === spotMarketMeta.symbol
    ).takerCommission;
    const tradeFee = toBNWei(tradeFeePct, 18).mul(amountToTransfer).div(toBNWei(100, 18));
    const destinationCoin = (await getAccountCoins(this.binanceApiClient)).find(
      (coin) => coin.symbol === destinationToken
    );
    const destinationTokenInfo = TOKEN_SYMBOLS_MAP[destinationToken];
    const withdrawFee = toBNWei(
      destinationCoin.networkList.find((network) => network.name === BINANCE_NETWORKS[destinationChain]).withdrawFee,
      destinationTokenInfo.decimals
    );
    const amountConverter = this._getAmountConverter(
      destinationChain,
      EvmAddress.from(TOKEN_SYMBOLS_MAP[destinationToken].addresses[destinationChain]),
      sourceChain,
      EvmAddress.from(TOKEN_SYMBOLS_MAP[sourceToken].addresses[sourceChain])
    );
    const withdrawFeeConvertedToSourceToken = amountConverter(withdrawFee);

    const { slippagePct, latestPrice } = await this._getLatestPrice(sourceToken, destinationToken, amountToTransfer);
    const slippage = toBNWei(slippagePct, 18).mul(amountToTransfer).div(toBNWei(100, 18));

    const isBuy = spotMarketMeta.isBuy;
    let spreadPct = 0;
    if (isBuy) {
      // if is buy, the fee is positive if the price is over 1
      spreadPct = latestPrice - 1;
    } else {
      spreadPct = 1 - latestPrice;
    }
    const spreadFee = toBNWei(spreadPct.toFixed(18), 18).mul(amountToTransfer).div(toBNWei(1, 18));
    const opportunityCostOfCapitalPct = 0; // todo.
    const opportunityCostOfCapital = toBNWei(opportunityCostOfCapitalPct, 18)
      .mul(amountToTransfer)
      .div(toBNWei(100, 18));
    const totalFee = tradeFee
      .add(withdrawFeeConvertedToSourceToken)
      .add(slippage)
      .add(spreadFee)
      .add(opportunityCostOfCapital);

    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter.getEstimatedCost",
      message: `Calculating total fees for rebalance route ${sourceToken} on ${getNetworkName(
        sourceChain
      )} to ${destinationToken} on ${getNetworkName(
        destinationChain
      )} with amount to transfer ${amountToTransfer.toString()}`,
      tradeFeePct,
      tradeFee: tradeFee.toString(),
      withdrawFeeConvertedToSourceToken: withdrawFeeConvertedToSourceToken.toString(),
      slippagePct,
      slippage: slippage.toString(),
      estimatedTakerPrice: latestPrice,
      spreadPct: spreadPct * 100,
      spreadFee: spreadFee.toString(),
      opportunityCostOfCapitalFixed: opportunityCostOfCapital.toString(),
      totalFee: totalFee.toString(),
    });

    return totalFee;
  }

  async _getBalance(token: string): Promise<number> {
    const accountCoins = await getAccountCoins(this.binanceApiClient);
    const coin = accountCoins.find((coin) => coin.symbol === token);
    return Number(coin.balance);
  }

  async _getSymbol(sourceToken: string, destinationToken: string) {
    const symbol = (await this.binanceApiClient.exchangeInfo()).symbols.find((symbols) => {
      return (
        symbols.symbol === `${sourceToken}${destinationToken}` || symbols.symbol === `${destinationToken}${sourceToken}`
      );
    });
    assert(symbol, `No market found for ${sourceToken} and ${destinationToken}`);
    return symbol;
  }

  async _getLatestPrice(
    sourceToken: string,
    destinationToken: string,
    amountToTransfer: BigNumber
  ): Promise<{ latestPrice: number; slippagePct: number }> {
    const symbol = await this._getSymbol(sourceToken, destinationToken);
    const destinationTokenInfo = TOKEN_SYMBOLS_MAP[destinationToken];
    const book = await this.binanceApiClient.book({ symbol: symbol.symbol });
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const sideOfBookToTraverse = spotMarketMeta.isBuy ? book.asks : book.bids;
    const bestPx = Number(sideOfBookToTraverse[0].price);
    let szFilledSoFar = bnZero;
    const maxPxReached = sideOfBookToTraverse.find((level) => {
      // Note: sz is always denominated in the base asset, so if we are buying, then the amountToTransfer (i.e.
      // the amount that we want to buy of the base asset) is denominated in the quote asset and we need to convert it
      // into the base asset.
      const sz = spotMarketMeta.isBuy ? Number(level.quantity) * Number(level.price) : Number(level.quantity);
      const szWei = toBNWei(sz.toFixed(destinationTokenInfo.decimals), destinationTokenInfo.decimals);
      if (szWei.gte(amountToTransfer)) {
        return true;
      }
      szFilledSoFar = szFilledSoFar.add(szWei);
    });
    if (!maxPxReached) {
      throw new Error(
        `Cannot find price in order book that satisfies an order for size ${amountToTransfer.toString()} of ${destinationToken} on the market "${sourceToken}-${destinationToken}"`
      );
    }
    const latestPrice = Number(Number(maxPxReached.price).toFixed(spotMarketMeta.pxDecimals));
    const slippagePct = Math.abs((latestPrice - bestPx) / bestPx) * 100;
    return { latestPrice, slippagePct };
  }

  protected _getQuantityForOrder(
    sourceToken: string,
    destinationToken: string,
    amountToTransfer: BigNumber,
    price: number
  ): number {
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const sz = spotMarketMeta.isBuy
      ? amountToTransfer.mul(10 ** spotMarketMeta.pxDecimals).div(toBNWei(price, spotMarketMeta.pxDecimals))
      : amountToTransfer;
    const destinationTokenInfo = TOKEN_SYMBOLS_MAP[destinationToken];
    const sourceTokenInfo = TOKEN_SYMBOLS_MAP[sourceToken];
    const evmDecimals = spotMarketMeta.isBuy ? destinationTokenInfo.decimals : sourceTokenInfo.decimals;
    const szFormatted = Number(Number(fromWei(sz, evmDecimals)).toFixed(spotMarketMeta.szDecimals));
    assert(szFormatted >= spotMarketMeta.minimumOrderSize, "amount to transfer is less than minimum order size");
    return szFormatted;
  }

  _getSpotMarketMetaForRoute(sourceToken: string, destinationToken: string): SPOT_MARKET_META {
    const name = `${sourceToken}-${destinationToken}`;
    return this.spotMarketMeta[name];
  }

  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();

    // const marketInfo = await this._getSymbol("USDC", "USDT");
    // console.log(`Market info:`, marketInfo);
    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
      message: `USDC Account Balance: ${await this._getBalance("USDC")}`,
    });
    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
      message: `USDT Account Balance: ${await this._getBalance("USDT")}`,
    });

    const pendingSwaps = await this._redisGetPendingSwaps();
    if (pendingSwaps.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
        message: `Found ${pendingSwaps.length} pending swaps`,
        pendingSwaps: pendingSwaps,
      });
    }
    for (const cloid of pendingSwaps) {
      const { destinationToken, destinationChain } = await this._redisGetOrderDetails(cloid);
      const matchingFill = await this._getMatchingFillForCloid(cloid);
      if (matchingFill) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Open order for cloid ${cloid} filled with size ${matchingFill.executedQty}! Proceeding to withdraw from Binance.`,
          cloid: cloid,
          matchingFill: matchingFill,
        });
        await this._withdraw(Number(matchingFill.executedQty), destinationToken, destinationChain);
        await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_SWAP, STATUS.PENDING_WITHDRAWAL);
      } else {
        // We throw an error here because we shouldn't expect the market order to ever not be filled.
        throw new Error(`No matching fill found for cloid ${cloid}`);
      }
    }

    const pendingDeposits = await this._redisGetPendingDeposits();
    if (pendingDeposits.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
        message: `Found ${pendingDeposits.length} pending deposits`,
        pendingDeposits: pendingDeposits,
      });
    }
    for (const cloid of pendingDeposits) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { sourceToken, amountToTransfer, destinationToken } = orderDetails;

      const latestPx = (await this._getLatestPrice(sourceToken, destinationToken, amountToTransfer)).latestPrice;
      const szForOrder = this._getQuantityForOrder(sourceToken, destinationToken, amountToTransfer, latestPx);
      const balance = await this._getBalance(sourceToken);
      if (balance < szForOrder) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Not enough balance to place order for cloid ${cloid}, balance: ${balance}`,
          cloid: cloid,
          balance: balance,
          szForOrder: szForOrder,
        });
        continue;
      }
      await this._placeMarketOrder(cloid, orderDetails);
      await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_DEPOSIT, STATUS.PENDING_SWAP);
    }

    const unfinalizedWithdrawalAmounts: { [destinationToken: string]: BigNumber } = {};
    const pendingWithdrawals = await this._redisGetPendingWithdrawals();
    if (pendingWithdrawals.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
        message: `Found ${pendingWithdrawals.length} pending withdrawals`,
        pendingWithdrawals: pendingWithdrawals,
      });
    }
    for (const cloid of pendingWithdrawals) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationToken, destinationChain } = orderDetails;
      const matchingFill = await this._getMatchingFillForCloid(cloid);
      if (!matchingFill) {
        throw new Error(`No matching fill found for cloid ${cloid} that has status PENDING_WITHDRAWAL`);
      }
      const initiatedWithdrawals = await this._getInitiatedBinanceWithdrawals(
        destinationToken,
        destinationChain,
        matchingFill.time
      );

      if (initiatedWithdrawals.length === 0) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Cannot find any initiated withdrawals that could correspond to cloid ${cloid} which filled at ${matchingFill.time}, waiting`,
          cloid: cloid,
          matchingFill: matchingFill,
        });
        continue;
      } // Only proceed to update the order status if it has finalized:
      const destinationTokenInfo = TOKEN_SYMBOLS_MAP[orderDetails.destinationToken];
      const expectedAmountToReceive = toBNWei(matchingFill.executedQty, destinationTokenInfo.decimals);
      const unfinalizedWithdrawalAmount =
        unfinalizedWithdrawalAmounts[orderDetails.destinationToken] ??
        (await this._getUnfinalizedWithdrawalAmount(
          orderDetails.destinationToken,
          orderDetails.destinationChain,
          Math.floor(matchingFill.time / 1000)
        ));
      if (unfinalizedWithdrawalAmount.gte(expectedAmountToReceive)) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Guessing order ${cloid} has not finalized yet because the unfinalized amount ${unfinalizedWithdrawalAmount.toString()} is >= than the expected withdrawal amount ${expectedAmountToReceive.toString()}`,
          cloid: cloid,
          unfinalizedWithdrawalAmount: unfinalizedWithdrawalAmount.toString(),
          expectedAmountToReceive: expectedAmountToReceive.toString(),
        });
        unfinalizedWithdrawalAmounts[orderDetails.destinationToken] =
          unfinalizedWithdrawalAmount.sub(expectedAmountToReceive);
        continue;
      }
      // We no longer need this order information, so we can delete it:
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
        message: `Order ${cloid} has finalized, deleting order`,
        cloid: cloid,
      });
      await this._redisDeleteOrder(cloid, STATUS.PENDING_WITHDRAWAL);
    }
    // PENDING_DEPOSIT: place new orders if enough balance and update status to PENDING_SWAP
    // PENDING_SWAP: Load open orders and matching fills. If a matching fill is found, initiate a withdrawal from Binance
    // and update status to PENDING_WITHDRAWAL_FROM_BINANCE. If no matching fill is found and no open order, then
    // replace the order. Otherwise do nothing.
    // PENDING_WITHDRAWAL: Check if withdrawal has been finalized, if it has then delete the order. Only look at withdrawals
    // with timestamp greater than matched fills for orders.
  }

  async _getMatchingFillForCloid(cloid: string) {
    const orderDetails = await this._redisGetOrderDetails(cloid);
    const spotMarketMeta = this._getSpotMarketMetaForRoute(orderDetails.sourceToken, orderDetails.destinationToken);
    const allOrders = await this.binanceApiClient.allOrders({
      symbol: spotMarketMeta.symbol,
    });
    const matchingFill = allOrders.find((order) => order.clientOrderId === cloid && order.status === "FILLED");
    return matchingFill;
  }

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question.
  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();

    const pendingOrders = await this._redisGetPendingOrders();
    if (pendingOrders.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Found ${pendingOrders.length} pending orders`,
        pendingOrders: pendingOrders,
      });
    }

    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

    // Add virtual balances for all pending orders:
    for (const cloid of pendingOrders) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationChain, destinationToken, sourceChain, sourceToken, amountToTransfer } = orderDetails;
      // Convert amountToTransfer to destination chain precision:
      const amountConverter = this._getAmountConverter(
        sourceChain,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[sourceToken].addresses[sourceChain]),
        destinationChain,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[destinationToken].addresses[destinationChain])
      );
      const convertedAmount = amountConverter(amountToTransfer);
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Adding ${convertedAmount.toString()} for pending order cloid ${cloid}`,
        cloid: cloid,
        convertedAmount: convertedAmount.toString(),
      });
      pendingRebalances[destinationChain] ??= {};
      pendingRebalances[destinationChain][destinationToken] = (
        pendingRebalances[destinationChain][destinationToken] ?? bnZero
      ).add(convertedAmount);
    }

    // Subtract virtual balance for pending withdrawals that have already finalized:
    const pendingWithdrawals = await this._redisGetPendingWithdrawals();
    const allDestinationChains = this.availableRoutes.map((x) => x.destinationChain);
    const allDestinationTokens = this.availableRoutes.map((x) => x.destinationToken);
    const unfinalizedWithdrawalAmounts: { [chainId: number]: { [token: string]: BigNumber } } = {};
    for (const destinationChain of allDestinationChains) {
      unfinalizedWithdrawalAmounts[destinationChain] = {};
      for (const destinationToken of allDestinationTokens) {
        unfinalizedWithdrawalAmounts[destinationChain][destinationToken] = await this._getUnfinalizedWithdrawalAmount(
          destinationToken,
          destinationChain,
          // Look for unfinalized withdrawals from the last day
          Math.floor(Date.now() / 1000) - 60 * 60 * 24
        );
      }
    }

    for (const cloid of pendingWithdrawals) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationChain, destinationToken } = orderDetails;
      const matchingFill = await this._getMatchingFillForCloid(cloid);

      const initiatedWithdrawals = await this._getInitiatedBinanceWithdrawals(
        destinationToken,
        destinationChain,
        matchingFill.time
      );

      if (initiatedWithdrawals.length === 0) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
          message: `Cannot find any initiated withdrawals that could correspond to cloid ${cloid} which filled at ${matchingFill.time}, waiting`,
          cloid: cloid,
          matchingFill: matchingFill,
        });
        continue;
      } // Only proceed to modify virtual balances if there is an initiated withdrawal for this fill

      const expectedAmountToReceive = toBNWei(
        matchingFill.executedQty,
        TOKEN_SYMBOLS_MAP[orderDetails.destinationToken].decimals
      );
      const unfinalizedWithdrawalAmount = unfinalizedWithdrawalAmounts[destinationChain][destinationToken];
      if (unfinalizedWithdrawalAmount.gte(expectedAmountToReceive)) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
          message: `Guessing order ${cloid} has not finalized yet because the unfinalized amount ${unfinalizedWithdrawalAmount.toString()} is >= than the expected withdrawal amount ${expectedAmountToReceive.toString()}`,
          cloid: cloid,
          unfinalizedWithdrawalAmount: unfinalizedWithdrawalAmount.toString(),
          expectedAmountToReceive: expectedAmountToReceive.toString(),
        });
        unfinalizedWithdrawalAmounts[destinationChain][destinationToken] =
          unfinalizedWithdrawalAmount.sub(expectedAmountToReceive);
        continue;
      }
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Withdrawal for order ${cloid} has finalized, subtracting the order's virtual balance of ${orderDetails.amountToTransfer.toString()} from Binance`,
        cloid: cloid,
        orderDetails: orderDetails,
      });
      pendingRebalances[destinationChain] ??= {};
      pendingRebalances[destinationChain][destinationToken] = (
        pendingRebalances[destinationChain][destinationToken] ?? bnZero
      ).sub(orderDetails.amountToTransfer);
    }

    return pendingRebalances;
    // For any orders with pending status add virtual balance to destination chain.
    // We need to make sure not to count orders with pending withdrawal status that have already finalized otherwise
    // we'll double count them. To do this, get the total unfinalized withdrawal amount from Binance and the
    // PENDING_WITHDRAWAL status orders. For each order, check if the order amount is less than the unfinalized withdrawal
    // amount. If it is, then we can assume this order is still pending, so subtract from the unfinalized withdrawal
    // amount counter and go to the next order. If the order amount is greater than the unfinalized withdrawal
    // then we can assume this order has finalized, so subtract a virtual balance credit for the order amount.
  }

  async _placeMarketOrder(cloid: string, orderDetails: OrderDetails): Promise<void> {
    const { sourceToken, destinationToken, amountToTransfer } = orderDetails;
    const latestPx = (await this._getLatestPrice(sourceToken, destinationToken, amountToTransfer)).latestPrice;
    const szForOrder = this._getQuantityForOrder(sourceToken, destinationToken, amountToTransfer, latestPx);
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const orderStruct = {
      symbol: spotMarketMeta.symbol,
      newClientOrderId: cloid,
      side: spotMarketMeta.isBuy ? "BUY" : "SELL",
      type: OrderType.MARKET,
      quantity: szForOrder.toString(),
      recvWindow: 60000,
    };
    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter._placeMarketOrder",
      message: `Placing ${spotMarketMeta.isBuy ? "BUY" : "SELL"} market order for ${
        spotMarketMeta.symbol
      } with size ${szForOrder}}`,
      orderStruct,
    });
    const response = await this.binanceApiClient.order(orderStruct as NewOrderSpot);
    assert(response.status == "FILLED", `Market order was not filled: ${JSON.stringify(response)}`);
    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter._placeMarketOrder",
      message: "Market order response",
      response,
    });
  }

  private async _getEventSearchConfig(fromTimestamp: number, chainId: number): Promise<EventSearchConfig> {
    const provider = await getProvider(chainId);
    const fromBlock = await getBlockForTimestamp(this.logger, chainId, fromTimestamp);
    const toBlock = await provider.getBlock("latest");
    const maxLookBack = this.config.maxBlockLookBack[chainId];
    return { from: fromBlock, to: toBlock.number, maxLookBack };
  }

  protected async _getInitiatedBinanceWithdrawals(token: string, chain: number, startTime: number) {
    return (await getBinanceWithdrawals(this.binanceApiClient, token, startTime)).filter(
      (withdrawal) =>
        withdrawal.coin === token &&
        withdrawal.network === BINANCE_NETWORKS[chain] &&
        withdrawal.recipient === this.baseSignerAddress.toNative() &&
        withdrawal.status > 4
      // @dev (0: Email Sent, 1: Cancelled 2: Awaiting Approval, 3: Rejected, 4: Processing, 5: Failure, 6: Completed)
    );
  }

  protected async _getUnfinalizedWithdrawalAmount(
    destinationToken: string,
    destinationChain: number,
    startTimeSeconds: number
  ): Promise<BigNumber> {
    const provider = await getProvider(destinationChain);
    const eventSearchConfig = await this._getEventSearchConfig(startTimeSeconds, destinationChain);
    const destinationTokenContract = new Contract(
      TOKEN_SYMBOLS_MAP[destinationToken].addresses[destinationChain],
      ERC20.abi,
      this.baseSigner.connect(provider)
    );
    const finalizedWithdrawals = await paginatedEventQuery(
      destinationTokenContract,
      destinationTokenContract.filters.Transfer(null, this.baseSignerAddress.toNative()),
      eventSearchConfig
    );
    const initiatedWithdrawals = await this._getInitiatedBinanceWithdrawals(
      destinationToken,
      destinationChain,
      startTimeSeconds * 1000
    );

    let unfinalizedWithdrawalAmount = bnZero;
    const finalizedWithdrawalTxnHashes = new Set<string>();
    for (const initiated of initiatedWithdrawals) {
      const withdrawalAmount = toBNWei(initiated.amount, TOKEN_SYMBOLS_MAP[destinationToken].decimals);
      const matchingFinalizedAmount = finalizedWithdrawals.find(
        (finalized) =>
          !finalizedWithdrawalTxnHashes.has(finalized.transactionHash) &&
          finalized.args.value.toString() === withdrawalAmount.toString()
      );
      if (matchingFinalizedAmount) {
        finalizedWithdrawalTxnHashes.add(matchingFinalizedAmount.transactionHash);
      } else {
        unfinalizedWithdrawalAmount = unfinalizedWithdrawalAmount.add(withdrawalAmount);
      }
    }
    return unfinalizedWithdrawalAmount;
  }

  protected async _withdraw(quantity: number, destinationToken: string, destinationChain: number): Promise<void> {
    // We need to truncate the amount to withdraw to the destination chain's decimal places.
    const destinationTokenInfo = TOKEN_SYMBOLS_MAP[destinationToken];
    const amountToWithdraw = Math.floor(quantity * destinationTokenInfo.decimals) / destinationTokenInfo.decimals;

    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter._withdraw",
      message: `Withdrawing ${amountToWithdraw} ${destinationToken} from Binance to chain ${BINANCE_NETWORKS[destinationChain]}`,
    });
    const withdrawalId = await this.binanceApiClient.withdraw({
      coin: destinationToken,
      address: this.baseSignerAddress.toNative(),
      amount: amountToWithdraw,
      network: BINANCE_NETWORKS[destinationChain],
      transactionFeeFlag: false,
    });
    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter._withdraw",
      message: "Success: Withdrawal ID",
      withdrawalId,
    });
  }

  protected _redisGetOrderStatusKey(status: STATUS): string {
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

  async _redisGetPendingDeposits(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_DEPOSIT);
    return sMembers;
  }

  async _redisGetPendingSwaps(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_SWAP);
    return sMembers;
  }

  async _redisGetPendingWithdrawals(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_WITHDRAWAL);
    return sMembers;
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
