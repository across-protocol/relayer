import { Binance } from "binance-api-node";
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
  getBinanceDeposits,
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
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";
import { RebalancerConfig } from "../RebalancerConfig";
import { RedisCache } from "../../caching/RedisCache";
import { BaseAdapter } from "./baseAdapter";
import { AugmentedTransaction } from "../../clients";

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

export class BinanceStablecoinSwapAdapter extends BaseAdapter implements RebalancerAdapter {
  private binanceApiClient: Binance;
  private availableRoutes: RebalanceRoute[];

  REDIS_PREFIX = "binance-stablecoin-swap:";
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

    // TODO: Can probably delete the following REST call by hardcoding the withdrawal minimums
    const accountCoins = await getAccountCoins(this.binanceApiClient);
    const destinationCoin = accountCoins.find((coin) => coin.symbol === destinationToken);
    const destinationNetwork = destinationCoin.networkList.find(
      (network) => network.name === BINANCE_NETWORKS[destinationChain]
    );

    // Convert input amount to destination amount and check its larger than minimum size
    const minimumWithdrawalSize = Number(destinationNetwork.withdrawMin);
    const maximumWithdrawalSize = Number(destinationNetwork.withdrawMax);

    const latestPx = await this._getLatestPrice(rebalanceRoute);
    const szForOrder = this._getQuantityForOrder(rebalanceRoute, latestPx);
    assert(
      szForOrder >= minimumWithdrawalSize,
      "amount to transfer is less than minimum withdrawal size on destination chain"
    );
    assert(
      szForOrder <= maximumWithdrawalSize,
      "amount to transfer is greater than maximum withdrawal size on destination chain"
    );
    const sourceTokenInfo = TOKEN_SYMBOLS_MAP[sourceToken];
    const amountToTransfer = toBNWei(szForOrder, sourceTokenInfo.decimals);

    // Deposit to Binance
    const depositAddress = await this.binanceApiClient.depositAddress({
      coin: sourceToken,
      network: BINANCE_NETWORKS[sourceChain],
    });
    const cloid = await this._redisGetNextCloid();
    console.log(
      `Creating new order ${cloid} by first transferring ${rebalanceRoute.sourceToken} into Binance from ${rebalanceRoute.sourceChain} to deposit address ${depositAddress.address}`
    );

    const sourceProvider = await getProvider(sourceChain);
    const sourceAddress = sourceTokenInfo.addresses[sourceChain];
    const erc20 = new Contract(sourceAddress, ERC20.abi, this.baseSigner.connect(sourceProvider));
    const txn: AugmentedTransaction = {
      contract: erc20,
      method: "transfer",
      args: [depositAddress.address, amountToTransfer],
      chainId: sourceChain,
      nonMulticall: true,
      unpermissioned: false,
      message: `Deposited ${szForOrder} ${sourceToken} to Binance on chain ${getNetworkName(sourceChain)}`,
      mrkdwn: `Deposited ${szForOrder} ${sourceToken} to Binance on chain ${getNetworkName(sourceChain)}`,
    };
    await this._submitTransaction(txn);
    await this._redisCreateOrder(cloid, STATUS.PENDING_DEPOSIT, rebalanceRoute);
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

  async _getLatestPrice(rebalanceRoute: RebalanceRoute): Promise<number> {
    const symbol = await this._getSymbol(rebalanceRoute.sourceToken, rebalanceRoute.destinationToken);
    const destinationTokenInfo = TOKEN_SYMBOLS_MAP[rebalanceRoute.destinationToken];
    const book = await this.binanceApiClient.book({ symbol: symbol.symbol });
    const spotMarketMeta = this._getSpotMarketMetaForRoute(rebalanceRoute.sourceToken, rebalanceRoute.destinationToken);
    const sideOfBookToTraverse = spotMarketMeta.isBuy ? book.asks : book.bids;
    console.log(
      `Fetching the price for a market order for the market "${rebalanceRoute.sourceToken}-${
        rebalanceRoute.destinationToken
      }" to ${spotMarketMeta.isBuy ? "buy" : "sell"} ${rebalanceRoute.maxAmountToTransfer.toString()} of ${
        rebalanceRoute.destinationToken
      }`
    );
    const bestPx = Number(sideOfBookToTraverse[0].price);
    console.log(`Best px: ${bestPx}`);
    console.log(`${spotMarketMeta.isBuy ? "Asks" : "Bids"} to traverse:`, sideOfBookToTraverse);
    let szFilledSoFar = bnZero;
    const maxPxReached = sideOfBookToTraverse.find((level, i) => {
      console.log(
        `szFilledSoFar: ${szFilledSoFar.toString()}, total size required to fill: ${rebalanceRoute.maxAmountToTransfer.toString()}`
      );
      // Note: sz is always denominated in the base asset, so if we are buying, then the maxAmountToTransfer (i.e.
      // the amount that we want to buy of the base asset) is denominated in the quote asset and we need to convert it
      // into the base asset.
      const sz = spotMarketMeta.isBuy ? Number(level.quantity) * Number(level.price) : Number(level.price);
      console.log(
        `Level size converted to source token (e.g. ${spotMarketMeta.isBuy ? "quote" : "base"} asset): ${sz}`
      );
      const szWei = toBNWei(level.quantity, destinationTokenInfo.decimals);
      if (szWei.gte(rebalanceRoute.maxAmountToTransfer)) {
        console.log(
          `Level ${i} with px=${
            level.price
          } is the max level to traverse because it has a size of ${szWei.toString()} which is >= than the max amount to transfer of ${rebalanceRoute.maxAmountToTransfer.toString()}`
        );
        return true;
      }
      console.log(
        `Checking the next level because the current level has a size of ${szWei.toString()} which is < than the max amount to transfer of ${rebalanceRoute.maxAmountToTransfer.toString()}`
      );
      szFilledSoFar = szFilledSoFar.add(szWei);
    });
    if (!maxPxReached) {
      throw new Error(
        `Cannot find price in order book that satisfies an order for size ${rebalanceRoute.maxAmountToTransfer.toString()} of ${
          rebalanceRoute.destinationToken
        } on the market "${rebalanceRoute.sourceToken}-${rebalanceRoute.destinationToken}"`
      );
    }
    return Number(maxPxReached.price);
  }

  _getQuantityForOrder(rebalanceRoute: RebalanceRoute, price: number) {
    const { sourceToken, destinationToken } = rebalanceRoute;
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const sz = spotMarketMeta.isBuy
      ? rebalanceRoute.maxAmountToTransfer
          .mul(10 ** spotMarketMeta.pxDecimals)
          .div(toBNWei(price, spotMarketMeta.pxDecimals))
      : rebalanceRoute.maxAmountToTransfer;
    const destinationTokenInfo = TOKEN_SYMBOLS_MAP[destinationToken];
    const sourceTokenInfo = TOKEN_SYMBOLS_MAP[sourceToken];
    const evmDecimals = spotMarketMeta.isBuy ? destinationTokenInfo.decimals : sourceTokenInfo.decimals;
    const szFormatted = Number(Number(fromWei(sz, evmDecimals)).toFixed(spotMarketMeta.szDecimals));
    assert(szFormatted >= spotMarketMeta.minimumOrderSize, "Max amount to transfer is less than minimum order size");
    return szFormatted;
  }

  _getSpotMarketMetaForRoute(sourceToken: string, destinationToken: string): SPOT_MARKET_META {
    const name = `${sourceToken}-${destinationToken}`;
    return this.spotMarketMeta[name];
  }

  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();

    const pendingDeposits = await this._redisGetPendingDeposits();
    for (const cloid of pendingDeposits) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const latestPx = await this._getLatestPrice(orderDetails);
      const szForOrder = this._getQuantityForOrder(orderDetails, latestPx);
      // Initiate a withdrawal for now back to the deposit chain
      await this._withdraw(szForOrder, orderDetails.sourceToken, orderDetails.sourceChain);
      await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_DEPOSIT, STATUS.PENDING_WITHDRAWAL);
    }

    const unfinalizedWithdrawalAmounts: { [destinationToken: string]: BigNumber } = {};
    const pendingWithdrawals = await this._redisGetPendingWithdrawals();
    for (const cloid of pendingWithdrawals) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      // const matchingFill = await this._getMatchingFill(cloid);
      const withdrawals = (
        await getBinanceWithdrawals(
          this.binanceApiClient,
          orderDetails.sourceToken, // Should be destinationToken
          Date.now() - 1000 * 60 * 60 * 24 // Should be matchingFill.time to only get withdrawals after fill
        )
      ).filter(
        (withdrawal) =>
          withdrawal.coin === orderDetails.sourceToken &&
          withdrawal.network === BINANCE_NETWORKS[orderDetails.sourceChain]
      );

      // if (withdrawals.length === 0) {
      //     console.log(
      //       `Cannot find any initiated withdrawals that could correspond to cloid ${cloid} which filled at ${matchingFill.details.time}, waiting`
      //     );
      //     continue;
      //   }
      console.log("potential matching withdrawals", withdrawals);
      const unfinalizedWithdrawalAmount = await this._getUnfinalizedWithdrawalAmount(
        orderDetails.sourceToken,
        orderDetails.sourceChain,
        Date.now() - 1000 * 60 * 60 * 24
      );
      console.log("unfinalized withdrawal amount", unfinalizedWithdrawalAmount.toString());
      // TODO:
    }
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

    const deposits = (await getBinanceDeposits(this.binanceApiClient, Date.now() - 1000 * 60 * 60 * 24)).filter(
      (deposit) =>
        deposit.coin === rebalanceRoute.sourceToken && deposit.network === BINANCE_NETWORKS[rebalanceRoute.sourceChain]
    );
    console.log("deposits", deposits);
    const withdrawals = (
      await getBinanceWithdrawals(
        this.binanceApiClient,
        rebalanceRoute.destinationToken,
        Date.now() - 1000 * 60 * 60 * 24
      )
    ).filter(
      (withdrawal) =>
        withdrawal.coin === rebalanceRoute.destinationToken &&
        withdrawal.network === BINANCE_NETWORKS[rebalanceRoute.destinationChain]
    );
    console.log("withdrawals", withdrawals);

    const pendingOrders = await this._redisGetPendingOrders();
    console.log("pending orders", pendingOrders);

    const pendingRebalances: { [chainId: number]: BigNumber } = {};
    for (const cloid of pendingOrders) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      // Convert maxAmountToTransfer to destination chain precision:
      const amountConverter = this._getAmountConverter(
        orderDetails.sourceChain,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[orderDetails.sourceToken].addresses[orderDetails.sourceChain]),
        orderDetails.destinationChain,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[orderDetails.destinationToken].addresses[orderDetails.destinationChain])
      );
      const convertedAmount = amountConverter(orderDetails.maxAmountToTransfer);
      console.log(`- Adding ${convertedAmount.toString()} for pending order cloid ${cloid}`);
      const existingPendingRebalanceAmountDestinationChain = pendingRebalances[orderDetails.destinationChain] ?? bnZero;
      pendingRebalances[orderDetails.destinationChain] =
        existingPendingRebalanceAmountDestinationChain.add(convertedAmount);
    }
    console.log(
      "- Total pending rebalance amounts",
      Object.entries(pendingRebalances)
        .map(([chainId, amount]) => `${getNetworkName(chainId)}: ${amount.toString()}`)
        .join(", ")
    );

    return pendingRebalances;
    // For any orders with pending status add virtual balance to destination chain.
    // We need to make sure not to count orders with pending withdrawal status that have already finalized otherwise
    // we'll double count them. To do this, get the total unfinalized withdrawal amount from Binance and the
    // PENDING_WITHDRAWAL status orders. For each order, check if the order amount is less than the unfinalized withdrawal
    // amount. If it is, then we can assume this order is still pending, so subtract from the unfinalized withdrawal
    // amount counter and go to the next order. If the order amount is greater than the unfinalized withdrawal
    // then we can assume this order has finalized, so subtract a virtual balance credit for the order amount.
  }

  private _getFromTimestamp(): number {
    return Math.floor(Date.now() / 1000) - 60 * 60 * 24; // 1 day ago
  }

  private async _getEventSearchConfig(chainId: number): Promise<EventSearchConfig> {
    const fromTimestamp = this._getFromTimestamp();
    const provider = await getProvider(chainId);
    const fromBlock = await getBlockForTimestamp(this.logger, chainId, fromTimestamp);
    const toBlock = await provider.getBlock("latest");
    const maxLookBack = this.config.maxBlockLookBack[chainId];
    return { from: fromBlock, to: toBlock.number, maxLookBack };
  }

  protected async _getCompletedBinanceWithdrawals(token: string, chain: number, startTime: number) {
    return (await getBinanceWithdrawals(this.binanceApiClient, token, startTime)).filter(
      (withdrawal) =>
        withdrawal.coin === token && withdrawal.network === BINANCE_NETWORKS[chain] && withdrawal.status === 6
    );
  }

  protected async _getUnfinalizedWithdrawalAmount(
    destinationToken: string,
    destinationChain: number,
    withdrawalInitiatedEarliestTimestamp: number
  ): Promise<BigNumber> {
    const provider = await getProvider(destinationChain);
    const eventSearchConfig = await this._getEventSearchConfig(destinationChain);
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
    const initiatedWithdrawals = await this._getCompletedBinanceWithdrawals(
      destinationToken,
      destinationChain,
      withdrawalInitiatedEarliestTimestamp
    );

    console.log(
      `Found ${initiatedWithdrawals.length} initiated withdrawals of ${destinationToken} to chain ${getNetworkName(
        destinationChain
      )} from Binance`
    );
    console.log(
      `Found ${finalizedWithdrawals.length} finalized withdrawals of ${destinationToken} to chain ${getNetworkName(
        destinationChain
      )} from Binance`
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
        console.log("Unfinalized withdrawal from Binance", initiated);
        unfinalizedWithdrawalAmount = unfinalizedWithdrawalAmount.add(withdrawalAmount);
      }
    }
    console.log(`Total unfinalized withdrawal amount from Binance: ${unfinalizedWithdrawalAmount.toString()}`);
    return unfinalizedWithdrawalAmount;
  }

  protected async _withdraw(quantity: number, destinationToken: string, destinationChain: number): Promise<void> {
    // We need to truncate the amount to withdraw to the destination chain's decimal places.
    const destinationTokenInfo = TOKEN_SYMBOLS_MAP[destinationToken];
    const amountToWithdraw = Math.floor(quantity * destinationTokenInfo.decimals) / destinationTokenInfo.decimals;

    console.log(
      `Withdrawing ${amountToWithdraw} ${destinationToken} from Binance to chain ${BINANCE_NETWORKS[destinationChain]}`
    );
    const withdrawalId = await this.binanceApiClient.withdraw({
      coin: destinationToken,
      address: this.baseSignerAddress.toNative(),
      amount: amountToWithdraw,
      network: BINANCE_NETWORKS[destinationChain],
      transactionFeeFlag: false,
    });
    console.log("Success: Withdrawal ID", withdrawalId);
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
