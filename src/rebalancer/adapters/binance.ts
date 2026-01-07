import { Binance, NewOrderSpot, OrderType, QueryOrderResult } from "binance-api-node";
import {
  assert,
  BigNumber,
  BINANCE_NETWORKS,
  bnZero,
  CHAIN_IDs,
  Coin,
  Contract,
  ERC20,
  forEachAsync,
  fromWei,
  getAccountCoins,
  getBinanceApiClient,
  getBinanceWithdrawals,
  getNetworkName,
  getProvider,
  getRedisCache,
  isDefined,
  paginatedEventQuery,
  Signer,
  toBNWei,
  winston,
} from "../../utils";
import { RebalanceRoute } from "../rebalancer";
import { RedisCache } from "../../caching/RedisCache";
import { BaseAdapter, OrderDetails } from "./baseAdapter";
import { AugmentedTransaction } from "../../clients";
import { RebalancerConfig } from "../RebalancerConfig";

enum STATUS {
  PENDING_BRIDGE_TO_BINANCE_NETWORK,
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

  REDIS_KEY_PENDING_BRIDGE_TO_BINANCE_NETWORK = this.REDIS_PREFIX + "pending-bridge-to-binance-network";
  REDIS_KEY_PENDING_DEPOSIT = this.REDIS_PREFIX + "pending-deposit";
  REDIS_KEY_PENDING_SWAP = this.REDIS_PREFIX + "pending-swap";
  REDIS_KEY_PENDING_WITHDRAWAL = this.REDIS_PREFIX + "pending-withdrawal";

  private allDestinationChains: Set<number>;
  private allDestinationTokens: Set<string>;
  private allSourceChains: Set<number>;
  private allSourceTokens: Set<string>;

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
    super(logger, config, baseSigner);
  }
  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    await super.initialize(_availableRoutes);

    this.redisCache = (await getRedisCache(this.logger)) as RedisCache;
    this.binanceApiClient = await getBinanceApiClient(process.env.BINANCE_API_BASE);

    this.availableRoutes = _availableRoutes;
    await forEachAsync(this.availableRoutes, async (route) => {
      const { sourceToken, destinationToken, sourceChain, destinationChain } = route;
      assert(
        BINANCE_NETWORKS[sourceChain] || this._chainIsBridgeable(sourceChain, sourceToken),
        `Source chain ${getNetworkName(
          sourceChain
        )} is not a binance network or supported by bridges for token ${sourceToken}`
      );
      assert(
        BINANCE_NETWORKS[destinationChain] || this._chainIsBridgeable(destinationChain, destinationToken),
        `Destination chain ${getNetworkName(
          destinationChain
        )} is not a binance network or supported by bridges for token ${destinationToken}`
      );
      const [sourceCoin, destinationCoin] = await Promise.all([
        this._getAccountCoins(sourceToken),
        this._getAccountCoins(destinationToken),
      ]);
      assert(sourceCoin, `Source token ${sourceToken} not found in account coins`);
      assert(destinationCoin, `Destination token ${destinationToken} not found in account coins`);
      const [sourceEntrypointNetwork, destinationEntrypointNetwork] = await Promise.all([
        this._getEntrypointNetwork(sourceChain, sourceToken),
        this._getEntrypointNetwork(destinationChain, destinationToken),
      ]);
      assert(
        sourceCoin.networkList.find((network) => network.name === BINANCE_NETWORKS[sourceEntrypointNetwork]),
        `Source token ${sourceToken} network list does not contain Binance source entrypoint network "${
          BINANCE_NETWORKS[sourceEntrypointNetwork]
        }", available networks: ${sourceCoin.networkList.map((network) => network.name).join(", ")}`
      );
      assert(
        destinationCoin.networkList.find((network) => network.name === BINANCE_NETWORKS[destinationEntrypointNetwork]),
        `Destination token ${destinationToken} network list does not contain Binance destination entrypoint network "${
          BINANCE_NETWORKS[destinationEntrypointNetwork]
        }", available networks: ${destinationCoin.networkList.map((network) => network.name).join(", ")}`
      );
    });

    this.allDestinationChains = new Set<number>(this.availableRoutes.map((x) => x.destinationChain));
    this.allDestinationTokens = new Set<string>(this.availableRoutes.map((x) => x.destinationToken));
    this.allSourceChains = new Set<number>(this.availableRoutes.map((x) => x.sourceChain));
    this.allSourceTokens = new Set<string>(this.availableRoutes.map((x) => x.sourceToken));
    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter.initialize",
      message: "Initialized BinanceStablecoinSwapAdapter",
      allDestinationChains: Array.from(this.allDestinationChains),
      allDestinationTokens: Array.from(this.allDestinationTokens),
      allSourceChains: Array.from(this.allSourceChains),
      allSourceTokens: Array.from(this.allSourceTokens),
    });
  }

  private async _getAccountCoins(symbol: string, skipCache = false): Promise<Coin> {
    const cacheKey = `binance-account-coins:${symbol}`;

    if (!skipCache) {
      const cachedAccountCoins = await this.redisCache.get<string>(cacheKey);
      if (cachedAccountCoins) {
        return JSON.parse(cachedAccountCoins) as Coin;
      }
    }
    const apiResponse = await getAccountCoins(this.binanceApiClient);
    const coin = apiResponse.find((coin) => coin.symbol === symbol);
    assert(coin, `Coin ${symbol} not found in account coins`);

    // Reset cache if we've fetched a new API response.
    await this.redisCache.set(cacheKey, JSON.stringify(coin)); // Use default TTL which is a long time as
    // the entry for this coin is not expected to change frequently.
    return coin;
  }

  protected async _getEntrypointNetwork(chainId: number, token: string): Promise<number> {
    // We like to use Arbitrum as a default Binance network because it is both a CCTP and OFT network as well and
    // has good stability and liquidity.
    const defaultBinanceNetwork = CHAIN_IDs.ARBITRUM;
    if (!BINANCE_NETWORKS[chainId]) {
      return defaultBinanceNetwork;
    }
    const coin = await this._getAccountCoins(token);
    const coinHasNetwork = coin.networkList.find((network) => network.name === BINANCE_NETWORKS[chainId]);
    return coinHasNetwork ? chainId : defaultBinanceNetwork;
  }

  async initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void> {
    this._assertInitialized();
    const { sourceChain, sourceToken, destinationToken, destinationChain } = rebalanceRoute;

    const destinationCoin = await this._getAccountCoins(destinationToken);
    const destinationEntrypointNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
    const destinationBinanceNetwork = destinationCoin.networkList.find(
      (network) => network.name === BINANCE_NETWORKS[destinationEntrypointNetwork]
    );
    const { withdrawMin, withdrawMax } = destinationBinanceNetwork;

    // Make sure that the amount to transfer will be larger than the minimum withdrawal size after expected fees.
    const expectedCost = await this.getEstimatedCost(rebalanceRoute, amountToTransfer, false);
    const expectedAmountToWithdraw = amountToTransfer.sub(expectedCost);
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
    const minimumWithdrawalSize = toBNWei(withdrawMin, sourceTokenInfo.decimals);
    const maximumWithdrawalSize = toBNWei(withdrawMax, sourceTokenInfo.decimals);
    assert(
      expectedAmountToWithdraw.gte(minimumWithdrawalSize),
      `Expected amount to withdraw ${expectedAmountToWithdraw.toString()} is less than minimum withdrawal size ${minimumWithdrawalSize.toString()} on Binance destination chain ${destinationEntrypointNetwork}`
    );
    assert(
      expectedAmountToWithdraw.lte(maximumWithdrawalSize),
      `Expected amount to withdraw ${expectedAmountToWithdraw.toString()} is greater than maximum withdrawal size ${maximumWithdrawalSize.toString()} on Binance destination chain ${destinationEntrypointNetwork}`
    );

    // TODO: The amount transferred here might produce dust due to the rounding required to meet the minimum order
    // tick size. We try not to precompute the size required to place an order here because the price might change
    // and the amount transferred in might be insufficient to place the order later on, producing more dust or an
    // error.
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const minimumOrderSize = toBNWei(spotMarketMeta.minimumOrderSize, sourceTokenInfo.decimals);
    assert(
      amountToTransfer.gte(minimumOrderSize),
      `Expected amount to withdraw ${expectedAmountToWithdraw.toString()} is less than minimum order size ${minimumOrderSize.toString()}`
    );

    const cloid = await this._redisGetNextCloid();

    // Select which chain we will be depositing and withdrawing the source tokens in to and out of Binance from.
    // If the chains are Binance networks, then we use the chain itself. Otherwise, we use the default Binance network
    // of Arbitrum, which is selected for convenience because it is both a CCTP and OFT network as well as a
    // Binance network with good stability.
    const binanceDepositNetwork = await this._getEntrypointNetwork(sourceChain, sourceToken);
    const requiresBridgeBeforeDeposit = binanceDepositNetwork !== sourceChain;
    if (requiresBridgeBeforeDeposit) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.initializeRebalance",
        message: `Creating new order ${cloid} by first bridging ${sourceToken} into ${getNetworkName(
          binanceDepositNetwork
        )} from ${getNetworkName(sourceChain)}`,
        destinationToken,
        destinationChain: getNetworkName(destinationChain),
        amountToTransfer: amountToTransfer.toString(),
      });
      const balance = await this._getERC20Balance(
        sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address.toNative()
      );
      if (balance.lt(amountToTransfer)) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.initializeRebalance",
          message: `Not enough balance on ${sourceChain} to bridge ${sourceToken} to ${binanceDepositNetwork} for ${amountToTransfer.toString()}, waiting...`,
          balance: balance.toString(),
          amountToTransfer: amountToTransfer.toString(),
        });
        return;
      }
      const amountReceivedFromBridge = await this._bridgeToChain(
        sourceToken,
        sourceChain,
        binanceDepositNetwork,
        amountToTransfer
      );
      await this._redisCreateOrder(
        cloid,
        STATUS.PENDING_BRIDGE_TO_BINANCE_NETWORK,
        rebalanceRoute,
        amountReceivedFromBridge
      );
    } else {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.initializeRebalance",
        message: `Creating new order ${cloid} by first transferring ${amountToTransfer.toString()} ${sourceToken} into Binance from ${getNetworkName(
          sourceChain
        )}`,
        destinationToken,
        destinationChain: getNetworkName(destinationChain),
      });
      await this._depositToBinance(sourceToken, sourceChain, amountToTransfer);
      await this._redisCreateOrder(cloid, STATUS.PENDING_DEPOSIT, rebalanceRoute, amountToTransfer);
    }
  }

  protected async _depositToBinance(
    sourceToken: string,
    sourceChain: number,
    amountToDeposit: BigNumber
  ): Promise<void> {
    assert(isDefined(BINANCE_NETWORKS[sourceChain]), "Source chain should be a Binance network");
    const depositAddress = await this.binanceApiClient.depositAddress({
      coin: sourceToken,
      network: BINANCE_NETWORKS[sourceChain],
    });
    const sourceProvider = await getProvider(sourceChain);
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
    const erc20 = new Contract(sourceTokenInfo.address.toNative(), ERC20.abi, this.baseSigner.connect(sourceProvider));
    const amountReadable = fromWei(amountToDeposit, sourceTokenInfo.decimals);
    const txn: AugmentedTransaction = {
      contract: erc20,
      method: "transfer",
      args: [depositAddress.address, amountToDeposit],
      chainId: sourceChain,
      nonMulticall: true,
      unpermissioned: false,
      message: `Deposited ${amountReadable} ${sourceToken} to Binance on chain ${getNetworkName(sourceChain)}`,
      mrkdwn: `Deposited ${amountReadable} ${sourceToken} to Binance on chain ${getNetworkName(sourceChain)}`,
    };
    await this._submitTransaction(txn);
  }

  async getEstimatedCost(
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    debugLog: boolean
  ): Promise<BigNumber> {
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    // Commission is denominated in percentage points.
    const tradeFeePct = (await this.binanceApiClient.tradeFee()).find(
      (fee) => fee.symbol === spotMarketMeta.symbol
    ).takerCommission;
    const tradeFee = toBNWei(tradeFeePct, 18).mul(amountToTransfer).div(toBNWei(100, 18));
    const destinationCoin = await this._getAccountCoins(destinationToken);
    const destinationEntrypointNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
    const destinationTokenInfo = this._getTokenInfo(destinationToken, destinationEntrypointNetwork);
    const withdrawFee = toBNWei(
      destinationCoin.networkList.find((network) => network.name === BINANCE_NETWORKS[destinationEntrypointNetwork])
        .withdrawFee,
      destinationTokenInfo.decimals
    );
    const amountConverter = this._getAmountConverter(
      destinationEntrypointNetwork,
      this._getTokenInfo(destinationToken, destinationEntrypointNetwork).address,
      sourceChain,
      this._getTokenInfo(sourceToken, sourceChain).address
    );
    const withdrawFeeConvertedToSourceToken = amountConverter(withdrawFee);

    const { slippagePct, latestPrice } = await this._getLatestPrice(
      sourceToken,
      destinationToken,
      sourceChain,
      amountToTransfer
    );
    const slippage = toBNWei(slippagePct, 18).mul(amountToTransfer).div(toBNWei(100, 18));

    // Bridge fee

    const isBuy = spotMarketMeta.isBuy;
    let spreadPct = 0;
    if (isBuy) {
      // if is buy, the fee is positive if the price is over 1
      spreadPct = latestPrice - 1;
    } else {
      spreadPct = 1 - latestPrice;
    }
    const spreadFee = toBNWei(spreadPct.toFixed(18), 18).mul(amountToTransfer).div(toBNWei(1, 18));

    // @todo: Move the following two components to the base adapter:

    // Bridge to Binance deposit network Fee:
    let bridgeToBinanceFee = bnZero;
    const binanceDepositNetwork = await this._getEntrypointNetwork(sourceChain, sourceToken);
    if (binanceDepositNetwork !== sourceChain) {
      bridgeToBinanceFee = await this._getBridgeFeePct(
        sourceChain,
        binanceDepositNetwork,
        sourceToken,
        amountToTransfer
      );
    }

    // Bridge from Binance withdrawal network fee:
    let bridgeFromBinanceFee = bnZero;
    const binanceWithdrawNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
    if (binanceWithdrawNetwork !== destinationChain) {
      bridgeFromBinanceFee = await this._getBridgeFeePct(
        destinationChain,
        binanceWithdrawNetwork,
        destinationToken,
        amountToTransfer
      );
    }

    // - Opportunity cost of capital should be 0 since all withdrawals are very fast, even if going over the CCTP/OFT
    // bridges.
    const opportunityCostOfCapitalBps = 0;
    const opportunityCostOfCapitalFixed = toBNWei(opportunityCostOfCapitalBps, 18)
      .mul(amountToTransfer)
      .div(toBNWei(10000, 18));

    const totalFee = tradeFee
      .add(withdrawFeeConvertedToSourceToken)
      .add(slippage)
      .add(spreadFee)
      .add(bridgeToBinanceFee)
      .add(bridgeFromBinanceFee)
      .add(opportunityCostOfCapitalFixed);

    if (debugLog) {
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
        opportunityCostOfCapitalFixed: opportunityCostOfCapitalFixed.toString(),
        bridgeToBinanceFee: bridgeToBinanceFee.toString(),
        bridgeFromBinanceFee: bridgeFromBinanceFee.toString(),
        totalFee: totalFee.toString(),
      });
    }

    return totalFee;
  }

  async _getBinanceBalance(token: string): Promise<number> {
    const coin = await this._getAccountCoins(token, true); // Skip cache so we load the balance fresh each time.
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
    sourceChain: number,
    amountToTransfer: BigNumber
  ): Promise<{ latestPrice: number; slippagePct: number }> {
    const symbol = await this._getSymbol(sourceToken, destinationToken);
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
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
      const szWei = toBNWei(sz.toFixed(sourceTokenInfo.decimals), sourceTokenInfo.decimals);
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
    sourceChain: number,
    destinationToken: string,
    amountToTransfer: BigNumber,
    price: number
  ): number {
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const sz = spotMarketMeta.isBuy
      ? amountToTransfer.mul(10 ** spotMarketMeta.pxDecimals).div(toBNWei(price, spotMarketMeta.pxDecimals))
      : amountToTransfer;
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
    const szFormatted = Number(Number(fromWei(sz, sourceTokenInfo.decimals)).toFixed(spotMarketMeta.szDecimals));
    assert(szFormatted >= spotMarketMeta.minimumOrderSize, "amount to transfer is less than minimum order size");
    return szFormatted;
  }

  _getSpotMarketMetaForRoute(sourceToken: string, destinationToken: string): SPOT_MARKET_META {
    const name = `${sourceToken}-${destinationToken}`;
    return this.spotMarketMeta[name];
  }

  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();

    // Pending bridge to Binance network
    const pendingBridgeToHyperevm = await this._redisGetPendingBridgeToBinanceNetwork();
    if (pendingBridgeToHyperevm.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending bridge to Binance network",
        pendingBridgeToHyperevm,
      });
    }
    for (const cloid of pendingBridgeToHyperevm) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { sourceToken, amountToTransfer, sourceChain } = orderDetails;
      const binanceDepositNetwork = await this._getEntrypointNetwork(sourceChain, sourceToken);
      // Check if we have enough balance on HyperEVM to progress the order status:
      const depositNetworkBalance = await this._getERC20Balance(
        binanceDepositNetwork,
        this._getTokenInfo(sourceToken, binanceDepositNetwork).address.toNative()
      );
      const amountConverter = this._getAmountConverter(
        orderDetails.sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address,
        binanceDepositNetwork,
        this._getTokenInfo(sourceToken, binanceDepositNetwork).address
      );
      const requiredAmountOnDepositNetwork = amountConverter(amountToTransfer);
      if (depositNetworkBalance.lt(requiredAmountOnDepositNetwork)) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Not enough ${sourceToken} balance on Binance deposit network ${binanceDepositNetwork} to progress the order ${cloid} with status PENDING_BRIDGE_TO_BINANCE_NETWORK`,
          depositNetworkBalance: depositNetworkBalance.toString(),
          requiredAmountOnDepositNetwork: requiredAmountOnDepositNetwork.toString(),
        });
      } else {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `We have enough ${sourceToken} balance on Binance deposit network ${binanceDepositNetwork} to initiate a deposit now for ${requiredAmountOnDepositNetwork.toString()} for order ${cloid}`,
          depositNetworkBalance: depositNetworkBalance.toString(),
        });
        await this._depositToBinance(sourceToken, binanceDepositNetwork, requiredAmountOnDepositNetwork);
        await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_BRIDGE_TO_BINANCE_NETWORK, STATUS.PENDING_DEPOSIT);
      }
    }

    // Place order if we have sufficient balance on Binance to do so.
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
      const { sourceToken, sourceChain, amountToTransfer, destinationToken } = orderDetails;

      const latestPx = (await this._getLatestPrice(sourceToken, destinationToken, sourceChain, amountToTransfer))
        .latestPrice;
      const szForOrder = this._getQuantityForOrder(
        sourceToken,
        sourceChain,
        destinationToken,
        amountToTransfer,
        latestPx
      );
      const balance = await this._getBinanceBalance(sourceToken);
      if (balance < szForOrder) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Not enough balance to place order for cloid ${cloid}, balance: ${balance}`,
          szForOrder: szForOrder,
        });
        continue;
      }
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
        message: `Sufficient balance to place market order for cloid ${cloid} with size ${szForOrder}`,
        binanceBalance: balance,
      });
      await this._placeMarketOrder(cloid, orderDetails);
      await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_DEPOSIT, STATUS.PENDING_SWAP);
    }

    // Withdraw pending swaps if they have filled.
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
        const balance = await this._getBinanceBalance(destinationToken);
        const withdrawAmount = Number(matchingFill.expectedAmountToReceive);
        if (balance < withdrawAmount) {
          this.logger.debug({
            at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
            message: `Not enough balance to withdraw ${withdrawAmount} ${destinationToken} for order ${cloid}, waiting...`,
            balance: balance,
          });
          continue;
        }
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Open order for cloid ${cloid} filled with size ${matchingFill.expectedAmountToReceive}! Proceeding to withdraw from Binance`,
          cloid: cloid,
          matchingFill: matchingFill,
          balanceBeforeWithdraw: balance,
        });
        await this._withdraw(withdrawAmount, destinationToken, destinationChain);
        await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_SWAP, STATUS.PENDING_WITHDRAWAL);
      } else {
        // We throw an error here because we shouldn't expect the market order to ever not be filled.
        throw new Error(`No matching fill found for cloid ${cloid}`);
      }
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
      // For each finalized withdrawal from Binance, delete its status from Redis and optionally initiate
      // a bridge to the final non-Binance network destination chain if necessary.

      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationToken, destinationChain, sourceToken, sourceChain, amountToTransfer } = orderDetails;
      const { matchingFill, expectedAmountToReceive: expectedAmountToReceiveString } =
        await this._getMatchingFillForCloid(cloid);
      if (!matchingFill) {
        throw new Error(`No matching fill found for cloid ${cloid} that has status PENDING_WITHDRAWAL`);
      }
      const binanceWithdrawalNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
      const initiatedWithdrawals = await this._getInitiatedBinanceWithdrawals(
        destinationToken,
        binanceWithdrawalNetwork,
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
      const destinationTokenInfo = this._getTokenInfo(destinationToken, binanceWithdrawalNetwork);
      const expectedAmountToReceivePreFees = toBNWei(expectedAmountToReceiveString, destinationTokenInfo.decimals);
      const expectedCost = await this.getEstimatedCost(
        {
          sourceToken,
          sourceChain,
          destinationToken,
          destinationChain,
          maxAmountToTransfer: amountToTransfer,
          adapter: "binance",
        },
        expectedAmountToReceivePreFees,
        false
      );

      // Make sure to subtract expected cost to account for receiving the expected amount less a withdrawal fee.
      const expectedAmountToReceive = expectedAmountToReceivePreFees.sub(expectedCost);
      const unfinalizedWithdrawalAmount =
        unfinalizedWithdrawalAmounts[orderDetails.destinationToken] ??
        (await this._getUnfinalizedWithdrawalAmount(
          orderDetails.destinationToken,
          binanceWithdrawalNetwork,
          Math.ceil(matchingFill.time / 1000) // Ceil this time so we only grab unfinalized withdrawals definitely sent
          // AFTER the fill's time
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

      // At this point, we know the withdrawal has finalized.
      // Check if we need to bridge the withdrawal to the final destination chain:
      const requiresBridgeAfterWithdrawal = binanceWithdrawalNetwork !== destinationChain;
      if (requiresBridgeAfterWithdrawal) {
        const balance = await this._getERC20Balance(
          binanceWithdrawalNetwork,
          this._getTokenInfo(destinationToken, binanceWithdrawalNetwork).address.toNative()
        );
        if (balance.lt(expectedAmountToReceive)) {
          this.logger.debug({
            at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
            message: `Not enough balance on ${binanceWithdrawalNetwork} to bridge ${destinationToken} to ${binanceWithdrawalNetwork} for ${expectedAmountToReceive.toString()}, waiting...`,
            balance: balance.toString(),
            amountToTransfer: expectedAmountToReceive.toString(),
          });
          continue;
        }
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Sending order with cloid ${cloid} from ${binanceWithdrawalNetwork} to final destination chain ${destinationChain}, and deleting order details from Redis!`,
          expectedAmountToReceive: expectedAmountToReceive.toString(),
          destinationToken,
        });
        await this._bridgeToChain(
          destinationToken,
          binanceWithdrawalNetwork,
          destinationChain,
          expectedAmountToReceive
        );
      } else {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Deleting order details from Redis with cloid ${cloid} because it has completed!`,
        });
      }
      // We no longer need this order information, so we can delete it.
      await this._redisDeleteOrder(cloid, STATUS.PENDING_WITHDRAWAL);
    }
  }

  async _getMatchingFillForCloid(
    cloid: string
  ): Promise<{ matchingFill: QueryOrderResult; expectedAmountToReceive: string } | undefined> {
    const orderDetails = await this._redisGetOrderDetails(cloid);
    const spotMarketMeta = this._getSpotMarketMetaForRoute(orderDetails.sourceToken, orderDetails.destinationToken);
    const allOrders = await this.binanceApiClient.allOrders({
      symbol: spotMarketMeta.symbol,
    });
    const matchingFill = allOrders.find((order) => order.clientOrderId === cloid && order.status === "FILLED");
    const expectedAmountToReceive = spotMarketMeta.isBuy ? matchingFill.executedQty : matchingFill.cummulativeQuoteQty;
    return { matchingFill, expectedAmountToReceive };
  }

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question.
  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

    // If there are any unfinalized bridges on the way to the destination chain, add virtual balances for them.
    await forEachAsync(Array.from(this.allDestinationTokens), async (destinationToken) => {
      await forEachAsync(Array.from(this.allDestinationChains), async (destinationChain) => {
        assert(
          !isDefined(pendingRebalances[destinationChain]?.[destinationToken]),
          "Destination chain should not have any pending rebalances for this destination token"
        );
        pendingRebalances[destinationChain] = {};
        const binanceWithdrawalNetworkForDestinationChain = await this._getEntrypointNetwork(
          destinationChain,
          destinationToken
        );
        const requiresBridgeAfterWithdrawal = binanceWithdrawalNetworkForDestinationChain !== destinationChain;
        if (requiresBridgeAfterWithdrawal) {
          let pendingRebalanceAmount;
          if (destinationToken === "USDT") {
            pendingRebalanceAmount = await this._getUnfinalizedOftBridgeAmount(
              binanceWithdrawalNetworkForDestinationChain,
              destinationChain
            );
          } else {
            pendingRebalanceAmount = await this._getUnfinalizedCctpBridgeAmount(
              binanceWithdrawalNetworkForDestinationChain,
              destinationChain
            );
          }
          if (pendingRebalanceAmount.gt(bnZero)) {
            this.logger.debug({
              at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
              message: `Adding ${pendingRebalanceAmount.toString()} ${destinationToken} for pending rebalances from ${binanceWithdrawalNetworkForDestinationChain} to ${destinationChain}`,
            });
            pendingRebalances[destinationChain][destinationToken] = pendingRebalanceAmount;
          }
        }
      });
    });

    // If there are any finalized bridges to non-Binance networks that need to be subsequently deposited
    // into Binance, subtract their virtual balances from the non-Binance networks.
    // 1. Load all pending finalized bridges to non-Binance networks
    // 2. For each order with status PENDING_BRIDGE_TO_BINANCE_NETWORK, subtract its virtual balance from unfinalized
    //    bridge amount. If there is no more unfinalized bridge amount, then the order can be considered to be finalized
    //    and we can subtract its virtual balance.

    const pendingBridgeToBinanceNetwork = await this._redisGetPendingBridgeToBinanceNetwork();
    if (pendingBridgeToBinanceNetwork.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Pending bridge to Binance deposit network cloids: ${pendingBridgeToBinanceNetwork.join(", ")}`,
      });
    }

    // If there are any finalized bridges to a Binance deposit network that correspond to orders that should subsequently be deposited
    // into Binance, we should subtract their virtual balance from the Binance deposit network.
    await forEachAsync(Array.from(this.allSourceTokens), async (sourceToken) => {
      await forEachAsync(Array.from(this.allSourceChains), async (sourceChain) => {
        const binanceDepositNetwork = await this._getEntrypointNetwork(sourceChain, sourceToken);
        const requiresBridgeBeforeDeposit = binanceDepositNetwork !== sourceChain;
        if (requiresBridgeBeforeDeposit) {
          let pendingRebalanceAmount = bnZero;
          if (sourceToken === "USDT") {
            pendingRebalanceAmount = await this._getUnfinalizedOftBridgeAmount(sourceChain, binanceDepositNetwork);
          } else {
            pendingRebalanceAmount = await this._getUnfinalizedCctpBridgeAmount(sourceChain, binanceDepositNetwork);
          }
          for (const cloid of pendingBridgeToBinanceNetwork) {
            const orderDetails = await this._redisGetOrderDetails(cloid);
            const { amountToTransfer } = orderDetails;
            if (orderDetails.sourceChain !== sourceChain || orderDetails.sourceToken !== sourceToken) {
              continue;
            }

            const amountConverter = this._getAmountConverter(
              sourceChain,
              this._getTokenInfo(sourceToken, sourceChain).address,
              binanceDepositNetwork,
              this._getTokenInfo(sourceToken, binanceDepositNetwork).address
            );

            // Check if this order is pending, if it is, then do nothing, but if it has finalized, then we need to subtract
            // its balance from the binance deposit network. We are assuming that the unfinalizedBridgeAmountToBinanceDepositNetwork is perfectly explained
            // by orders with status PENDING_BRIDGE_TO_BINANCE_NETWORK.
            const convertedOrderAmount = amountConverter(amountToTransfer);

            // The algorithm here is a bit subtle. We can't easily associate pending OFT/CCTP rebalances with order cloids,
            // unless we saved the transaction hash down at the time of creating the cloid and initiating the bridge to
            // binance deposit network. (If we did do that, then we'd need to keep track of pending rebalances and we'd have to
            // update them in the event queries above). The alternative implementation we use is to track the total
            // pending unfinalized amount, and subtract any order expected amounts from the pending amount. We can then
            // back into how many of these pending bridges to binance deposit network have finalized.
            if (pendingRebalanceAmount.gte(convertedOrderAmount)) {
              this.logger.debug({
                at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
                message: `Order cloid ${cloid} is possibly pending finalization to binance deposit network ${binanceDepositNetwork} still (remaining pending amount: ${pendingRebalanceAmount.toString()} ${sourceToken}, order expected amount: ${convertedOrderAmount.toString()})`,
              });

              pendingRebalanceAmount = pendingRebalanceAmount.sub(convertedOrderAmount);
              continue;
            }

            // Order has finalized, subtract virtual balance from the binance deposit network:
            this.logger.debug({
              at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
              message: `Subtracting ${convertedOrderAmount.toString()} ${sourceToken} for order cloid ${cloid} that has finalized bridging to binance deposit network ${binanceDepositNetwork}`,
            });
            pendingRebalances[binanceDepositNetwork] ??= {};
            pendingRebalances[binanceDepositNetwork][sourceToken] = (
              pendingRebalances[binanceDepositNetwork][sourceToken] ?? bnZero
            ).sub(convertedOrderAmount);
          }
        }
      });
    });

    const pendingOrders = await this._redisGetPendingOrders();
    if (pendingOrders.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Found ${pendingOrders.length} pending orders`,
        pendingOrders: pendingOrders,
      });
    }

    // Add virtual balances for all pending orders:
    for (const cloid of pendingOrders) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationChain, destinationToken, sourceChain, sourceToken, amountToTransfer } = orderDetails;
      // Convert amountToTransfer to destination chain precision:
      const amountConverter = this._getAmountConverter(
        sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address,
        destinationChain,
        this._getTokenInfo(destinationToken, destinationChain).address
      );
      const convertedAmount = amountConverter(amountToTransfer);
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Adding ${convertedAmount.toString()} for pending order cloid ${cloid} to destination chain ${destinationChain}`,
        cloid: cloid,
      });
      pendingRebalances[destinationChain] ??= {};
      pendingRebalances[destinationChain][destinationToken] = (
        pendingRebalances[destinationChain][destinationToken] ?? bnZero
      ).add(convertedAmount);
    }

    // Subtract virtual balance for pending withdrawals that have already finalized:

    // First, calculate the total unfinalized withdrawal amount for each destination chain and token:
    const pendingWithdrawals = await this._redisGetPendingWithdrawals();
    const unfinalizedWithdrawalAmounts: { [chainId: number]: { [token: string]: BigNumber } } = {};
    await forEachAsync(Array.from(this.allDestinationChains), async (destinationChain) => {
      await forEachAsync(Array.from(this.allDestinationTokens), async (destinationToken) => {
        const binanceWithdrawalNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
        assert(
          !isDefined(unfinalizedWithdrawalAmounts[binanceWithdrawalNetwork]?.[destinationToken]),
          "Unfinalized withdrawal amounts should not have any pending rebalances for this destination token"
        );
        unfinalizedWithdrawalAmounts[binanceWithdrawalNetwork] = {};
        unfinalizedWithdrawalAmounts[binanceWithdrawalNetwork][destinationToken] =
          await this._getUnfinalizedWithdrawalAmount(
            destinationToken,
            binanceWithdrawalNetwork,
            this._getFromTimestamp()
          );
      });
    });

    // For each pending withdrawal from Binance, check if it has finalized, and if it has, subtract its virtual balance from the binance withdrawal network.
    for (const cloid of pendingWithdrawals) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationChain, destinationToken } = orderDetails;
      const { matchingFill, expectedAmountToReceive: expectedAmountToReceiveString } =
        await this._getMatchingFillForCloid(cloid);

      const binanceWithdrawalNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
      const initiatedWithdrawals = await this._getInitiatedBinanceWithdrawals(
        destinationToken,
        binanceWithdrawalNetwork,
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
        expectedAmountToReceiveString,
        this._getTokenInfo(destinationToken, binanceWithdrawalNetwork).decimals
      );
      const unfinalizedWithdrawalAmount = unfinalizedWithdrawalAmounts[binanceWithdrawalNetwork][destinationToken];
      if (unfinalizedWithdrawalAmount.gte(expectedAmountToReceive)) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
          message: `Guessing order ${cloid} has not finalized yet because the unfinalized amount ${unfinalizedWithdrawalAmount.toString()} is >= than the expected withdrawal amount ${expectedAmountToReceive.toString()}`,
          cloid: cloid,
          unfinalizedWithdrawalAmount: unfinalizedWithdrawalAmount.toString(),
          expectedAmountToReceive: expectedAmountToReceive.toString(),
        });
        unfinalizedWithdrawalAmounts[binanceWithdrawalNetwork][destinationToken] =
          unfinalizedWithdrawalAmount.sub(expectedAmountToReceive);
        continue;
      }
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Withdrawal for order ${cloid} has finalized, subtracting the order's virtual balance of ${orderDetails.amountToTransfer.toString()} from binance withdrawal network ${binanceWithdrawalNetwork}`,
        cloid: cloid,
        orderDetails: orderDetails,
      });
      pendingRebalances[binanceWithdrawalNetwork] ??= {};
      pendingRebalances[binanceWithdrawalNetwork][destinationToken] = (
        pendingRebalances[binanceWithdrawalNetwork][destinationToken] ?? bnZero
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
    const { sourceToken, sourceChain, destinationToken, amountToTransfer } = orderDetails;
    const latestPx = (await this._getLatestPrice(sourceToken, destinationToken, sourceChain, amountToTransfer))
      .latestPrice;
    const szForOrder = this._getQuantityForOrder(
      sourceToken,
      sourceChain,
      destinationToken,
      amountToTransfer,
      latestPx
    );
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
      } with size ${szForOrder}`,
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

  protected async _getInitiatedBinanceWithdrawals(token: string, chain: number, startTime: number) {
    assert(isDefined(BINANCE_NETWORKS[chain]), "Chain should be a Binance network");
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
    assert(isDefined(BINANCE_NETWORKS[destinationChain]), "Destination chain should be a Binance network");
    const provider = await getProvider(destinationChain);
    const eventSearchConfig = await this._getEventSearchConfig(destinationChain);
    const destinationTokenContract = new Contract(
      this._getTokenInfo(destinationToken, destinationChain).address.toNative(),
      ERC20.abi,
      this.baseSigner.connect(provider)
    );
    const finalizedWithdrawals = await paginatedEventQuery(
      destinationTokenContract,
      destinationTokenContract.filters.Transfer(null, this.baseSignerAddress.toNative()),
      eventSearchConfig
    );
    // @todo: Make sure that the finalized event query time range is after the initiated event query, otherwise we might
    // see false positives of unfinalized withdrawals just because we're not looking at the right time range for the
    // the finalized events. The assumption we want to maintain is that we see all possible finalized events
    // for the chosen inititated events.
    const initiatedWithdrawals = await this._getInitiatedBinanceWithdrawals(
      destinationToken,
      destinationChain,
      startTimeSeconds * 1000
    );

    let unfinalizedWithdrawalAmount = bnZero;
    const finalizedWithdrawalTxnHashes = new Set<string>();
    for (const initiated of initiatedWithdrawals) {
      const withdrawalAmount = toBNWei(
        initiated.amount, // @dev This should be the post-withdrawal fee amount so it should match perfectly
        // with the finalized amount.
        this._getTokenInfo(destinationToken, destinationChain).decimals
      );
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
    const destinationEntrypointNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);

    // We need to truncate the amount to withdraw to the destination chain's decimal places.
    const destinationTokenInfo = this._getTokenInfo(destinationToken, destinationEntrypointNetwork);
    const amountToWithdraw = quantity.toFixed(destinationTokenInfo.decimals);
    const withdrawalId = await this.binanceApiClient.withdraw({
      coin: destinationToken,
      address: this.baseSignerAddress.toNative(),
      amount: Number(amountToWithdraw),
      network: BINANCE_NETWORKS[destinationEntrypointNetwork],
      transactionFeeFlag: false,
    });
    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter._withdraw",
      message: `Successfully withdrew ${quantity} ${destinationToken} from Binance to withdrawal network ${destinationEntrypointNetwork}`,
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
      case STATUS.PENDING_BRIDGE_TO_BINANCE_NETWORK:
        orderStatusKey = this.REDIS_KEY_PENDING_BRIDGE_TO_BINANCE_NETWORK;
        break;
      default:
        throw new Error(`Invalid status: ${status}`);
    }
    return orderStatusKey;
  }

  async _redisGetPendingBridgeToBinanceNetwork(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_BRIDGE_TO_BINANCE_NETWORK);
    return sMembers;
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
    const [pendingDeposits, pendingSwaps, pendingWithdrawals, pendingBridgeToBinanceNetwork] = await Promise.all([
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_DEPOSIT),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_SWAP),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_WITHDRAWAL),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_BRIDGE_TO_BINANCE_NETWORK),
    ]);
    return [...pendingDeposits, ...pendingSwaps, ...pendingWithdrawals, ...pendingBridgeToBinanceNetwork];
  }

  private _assertInitialized(): void {
    assert(this.initialized, "BinanceStablecoinSwapAdapter not initialized");
  }
}
