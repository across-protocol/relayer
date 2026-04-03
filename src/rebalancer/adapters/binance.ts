import { Binance, NewOrderSpot, OrderType, QueryOrderResult } from "binance-api-node";
import {
  assert,
  BigNumber,
  BINANCE_NETWORKS,
  BinanceTransactionType,
  BinanceWithdrawal,
  bnZero,
  CHAIN_IDs,
  Coin,
  Contract,
  delay,
  ERC20,
  forEachAsync,
  fromWei,
  getAccountCoins,
  getBinanceApiClient,
  getBinanceTransactionTypeKey,
  getBinanceWithdrawals,
  getNetworkName,
  getProvider,
  isDefined,
  paginatedEventQuery,
  setBinanceDepositType,
  setBinanceWithdrawalType,
  Signer,
  toBNWei,
  truncate,
  winston,
} from "../../utils";
import { RebalanceRoute } from "../utils/interfaces";
import { BaseAdapter, OrderDetails, STATUS } from "./baseAdapter";
import { AugmentedTransaction } from "../../clients";
import { RebalancerConfig } from "../RebalancerConfig";
import { CctpAdapter } from "./cctpAdapter";
import { OftAdapter } from "./oftAdapter";
export interface SPOT_MARKET_META {
  symbol: string;
  baseAssetName: string;
  quoteAssetName: string;
  pxDecimals: number;
  szDecimals: number;
  minimumOrderSize: number;
  isBuy: boolean;
}

type ExchangeInfoSymbol = Awaited<ReturnType<Binance["exchangeInfo"]>>["symbols"][number];

export function resolveBinanceCoinSymbol(token: string): string {
  return token === "WETH" ? "ETH" : token;
}

export function deriveBinanceSpotMarketMeta(
  sourceToken: string,
  destinationToken: string,
  symbol: ExchangeInfoSymbol
): SPOT_MARKET_META {
  const sourceAsset = resolveBinanceCoinSymbol(sourceToken);
  const destinationAsset = resolveBinanceCoinSymbol(destinationToken);
  const isBuy = symbol.baseAsset === destinationAsset && symbol.quoteAsset === sourceAsset;
  const isSell = symbol.baseAsset === sourceAsset && symbol.quoteAsset === destinationAsset;
  assert(isBuy || isSell, `No spot market meta found for route: ${sourceToken}-${destinationToken}`);

  const priceFilter = symbol.filters.find((filter) => filter.filterType === "PRICE_FILTER");
  const sizeFilter = symbol.filters.find((filter) => filter.filterType === "LOT_SIZE");
  assert(isDefined(priceFilter?.tickSize), `PRICE_FILTER missing tickSize for ${symbol.symbol}`);
  assert(isDefined(sizeFilter?.stepSize) && isDefined(sizeFilter?.minQty), `LOT_SIZE missing for ${symbol.symbol}`);

  return {
    symbol: symbol.symbol,
    baseAssetName: symbol.baseAsset,
    quoteAssetName: symbol.quoteAsset,
    pxDecimals: resolveStepPrecision(priceFilter.tickSize),
    szDecimals: resolveStepPrecision(sizeFilter.stepSize),
    minimumOrderSize: Number(sizeFilter.minQty),
    isBuy,
  };
}

export function convertBinanceRouteAmount(params: {
  amount: BigNumber;
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
  isBuy: boolean;
  price: number;
  direction: "source-to-destination" | "destination-to-source";
}): BigNumber {
  const isSourceToDestination = params.direction === "source-to-destination";
  const inputDecimals = isSourceToDestination ? params.sourceTokenDecimals : params.destinationTokenDecimals;
  const outputDecimals = isSourceToDestination ? params.destinationTokenDecimals : params.sourceTokenDecimals;
  const readableAmount = Number(fromWei(params.amount, inputDecimals));
  const convertedAmount = isSourceToDestination
    ? params.isBuy
      ? readableAmount / params.price
      : readableAmount * params.price
    : params.isBuy
      ? readableAmount * params.price
      : readableAmount / params.price;

  return toBNWei(truncate(convertedAmount, outputDecimals), outputDecimals);
}

function resolveStepPrecision(stepSize: string): number {
  const normalized = stepSize.replace(/0+$/, "").replace(/\.$/, "");
  const decimalPart = normalized.split(".")[1];
  return decimalPart?.length ?? 0;
}

export class BinanceStablecoinSwapAdapter extends BaseAdapter {
  private binanceApiClient: Binance;
  private tradeFeesPromise?: ReturnType<Binance["tradeFee"]>;
  private exchangeInfoPromise?: ReturnType<Binance["exchangeInfo"]>;
  private orderBookPromiseBySymbol = new Map<string, Promise<Awaited<ReturnType<Binance["book"]>>>>();
  private orderBookSnapshotBySymbol = new Map<
    string,
    { fetchedAtMs: number; book: Awaited<ReturnType<Binance["book"]>> }
  >();
  private spotMarketMetaPromiseByRoute = new Map<string, Promise<SPOT_MARKET_META>>();

  REDIS_PREFIX = "binance-stablecoin-swap:";
  private static readonly ORDER_BOOK_CACHE_TTL_MS = 30_000;

  REDIS_KEY_INITIATED_WITHDRAWALS = this.REDIS_PREFIX + "initiated-withdrawals";
  constructor(
    readonly logger: winston.Logger,
    readonly config: RebalancerConfig,
    readonly baseSigner: Signer,
    readonly cctpAdapter: CctpAdapter,
    readonly oftAdapter: OftAdapter
  ) {
    super(logger, config, baseSigner);
  }

  // ////////////////////////////////////////////////////////////
  // PUBLIC METHODS
  // ////////////////////////////////////////////////////////////

  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    if (this.initialized) {
      return;
    }
    await super.initialize(_availableRoutes.filter((route) => route.adapter === "binance"));

    this.binanceApiClient = await getBinanceApiClient(process.env.BINANCE_API_BASE);

    await forEachAsync(this.availableRoutes, async (route) => {
      const { sourceToken, destinationToken, sourceChain, destinationChain } = route;
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
      const getIntermediateAdapter = (token: string) => (token === "USDT" ? this.oftAdapter : this.cctpAdapter);
      const getIntermediateAdapterName = (token: string) => (token === "USDT" ? "oft" : "cctp");
      // Validate that route can be supported using intermediate bridges to get to/from Arbitrum to access Binance.
      if (destinationEntrypointNetwork !== destinationChain) {
        const intermediateRoute = {
          ...route,
          sourceChain: destinationEntrypointNetwork,
          sourceToken: destinationToken,
          adapter: getIntermediateAdapterName(destinationToken),
        };
        assert(
          getIntermediateAdapter(destinationToken).supportsRoute(intermediateRoute),
          `Destination chain ${getNetworkName(
            destinationChain
          )} is not a valid final destination chain for token ${destinationToken} because it doesn't have a ${getIntermediateAdapterName(
            destinationToken
          )} bridge route from the Binance entry point network ${destinationEntrypointNetwork}`
        );
      }
      if (sourceEntrypointNetwork !== sourceChain) {
        const intermediateRoute = {
          ...route,
          destinationChain: sourceEntrypointNetwork,
          destinationToken: sourceToken,
          adapter: getIntermediateAdapterName(sourceToken),
        };
        assert(
          getIntermediateAdapter(sourceToken).supportsRoute(intermediateRoute),
          `Source chain ${getNetworkName(
            sourceChain
          )} is not a valid source chain for token ${sourceToken} because it doesn't have a ${getIntermediateAdapterName(
            sourceToken
          )} bridge route to the Binance entrypoint network ${sourceEntrypointNetwork}`
        );
      }
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
  }

  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();

    // Pending bridges to Binance network: we'll attempt to deposit the tokens to Binance if we have enough balance.
    const pendingBridgeToBinanceDepositNetwork = await this._redisGetPendingBridgesPreDeposit();
    if (pendingBridgeToBinanceDepositNetwork.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending bridge to Binance network",
        pendingBridgeToBinanceDepositNetwork,
      });
    }
    for (const cloid of pendingBridgeToBinanceDepositNetwork) {
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
        await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_BRIDGE_PRE_DEPOSIT, STATUS.PENDING_DEPOSIT);
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
      const { sourceToken, sourceChain, amountToTransfer } = orderDetails;

      const binanceBalance = await this._getBinanceBalance(sourceToken);
      const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
      const binanceBalanceWei = toBNWei(truncate(binanceBalance, sourceTokenInfo.decimals), sourceTokenInfo.decimals);
      if (binanceBalanceWei.lt(amountToTransfer)) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Available balance for input token: ${sourceToken} (${binanceBalanceWei.toString()}) is less than amount to transfer: ${amountToTransfer.toString()}`,
        });
        continue;
      }
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
        message: `Sufficient balance to place market order for cloid ${cloid}`,
        availableBalance: binanceBalanceWei.toString(),
        requiredBalance: amountToTransfer.toString(),
      });
      await this._placeMarketOrder(cloid, orderDetails);
      await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_DEPOSIT, STATUS.PENDING_SWAP);
      // Delay a bit before checking balances to withdraw so we can give this function a chance to successively place
      // a market order successfully and subsequently withdraw the filled order. It takes a short time for the just filled
      // order to be reflected in the balance.
      await this._wait(10);
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
        await this._withdraw(cloid, withdrawAmount, destinationToken, destinationChain);
        await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_SWAP, STATUS.PENDING_WITHDRAWAL);
        // Delay a bit before checking checking whether this withdrawal has finalized so we have a chance at immediately
        // marking it as finalized and delete it from Redis.
        await this._wait(10);
      } else {
        // We throw an error here because we shouldn't expect the market order to ever not be filled.
        throw new Error(`No matching fill found for cloid ${cloid}`);
      }
    }

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
      const { destinationToken, destinationChain } = orderDetails;
      const { matchingFill } = await this._getMatchingFillForCloid(cloid);
      if (!matchingFill) {
        throw new Error(`No matching fill found for cloid ${cloid} that has status PENDING_WITHDRAWAL`);
      }
      const binanceWithdrawalNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
      const initiatedWithdrawalId = await this._redisGetInitiatedWithdrawalId(cloid);
      if (!initiatedWithdrawalId) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Cannot find initiated withdrawal for cloid ${cloid} which filled at ${matchingFill.time}, waiting`,
          cloid: cloid,
          matchingFill: matchingFill,
        });
        continue;
      } // Only proceed to update the order status if it has finalized:
      // @todo: Can we cache this result to avoid making the same query for orders with the same destination token and withdrawal network?
      const { unfinalizedWithdrawals, finalizedWithdrawals } = await this._getBinanceWithdrawals(
        orderDetails.destinationToken,
        binanceWithdrawalNetwork,
        Math.floor(matchingFill.time / 1000) - 5 * 60 // Floor this so we can grab the initiated withdrawal data whose
        // ID we've already saved into Redis
      );
      const initiatedWithdrawalIsUnfinalized = unfinalizedWithdrawals.find(
        (withdrawal) => withdrawal.id === initiatedWithdrawalId
      );
      if (initiatedWithdrawalIsUnfinalized) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Withdrawal for order ${cloid} for ${destinationToken} to binance withdrawal network ${binanceWithdrawalNetwork} has not finalized yet`,
          cloid: cloid,
          initiatedWithdrawalId,
        });
        continue;
      }

      // The withdrawal has finalized, fetch its withdrawal details from the Binance API.
      const withdrawalDetails = finalizedWithdrawals.find((withdrawal) => withdrawal.id === initiatedWithdrawalId);
      if (!withdrawalDetails) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Cannot find withdrawal details in Binance API response for withdrawal history for cloid ${cloid} which filled at ${matchingFill.time}, waiting....`,
        });
        continue;
      }

      // Check if we need to bridge the withdrawal to the final destination chain:
      const requiresBridgeAfterWithdrawal = binanceWithdrawalNetwork !== destinationChain;
      if (requiresBridgeAfterWithdrawal) {
        const balance = await this._getERC20Balance(
          binanceWithdrawalNetwork,
          this._getTokenInfo(destinationToken, binanceWithdrawalNetwork).address.toNative()
        );
        const binanceWithdrawalNetworkTokenInfo = this._getTokenInfo(destinationToken, binanceWithdrawalNetwork);
        const withdrawAmountWei = toBNWei(
          truncate(withdrawalDetails.amount, binanceWithdrawalNetworkTokenInfo.decimals),
          binanceWithdrawalNetworkTokenInfo.decimals
        );
        if (balance.lt(withdrawAmountWei)) {
          this.logger.debug({
            at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
            message: `Order ${cloid} has finalized withdrawing to ${binanceWithdrawalNetwork} and needs to be bridged to final destination chain ${destinationChain}, but there is not enough balance on ${binanceWithdrawalNetwork} to bridge ${destinationToken} to ${destinationChain} for ${withdrawAmountWei.toString()}, waiting...`,
            balance: balance.toString(),
            requiredWithdrawAmount: withdrawAmountWei.toString(),
            withdrawalDetails,
          });
          continue;
        }
        this.logger.info({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `✨ Order ${cloid} has finalized withdrawing to ${binanceWithdrawalNetwork}; bridging ${destinationToken} from ${binanceWithdrawalNetwork} to final destination chain ${destinationChain} and deleting order details from Redis!`,
          requiredWithdrawAmount: withdrawAmountWei.toString(),
          destinationToken,
          withdrawalDetails,
        });
        await this._bridgeToChain(destinationToken, binanceWithdrawalNetwork, destinationChain, withdrawAmountWei);
      } else {
        this.logger.info({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `✨ Deleting order details from Redis with cloid ${cloid} because its withdrawal has finalized to the final destination chain ${destinationChain}!`,
          withdrawalDetails,
        });
      }
      // We no longer need this order information, so we can delete it.
      await this._redisDeleteOrder(cloid, STATUS.PENDING_WITHDRAWAL);
    }
  }

  async sweepIntermediateBalances(): Promise<void> {
    // no-op for Binance, since we don't know if the funds on Binance are being used for the InventoryClient's Binance
    // rebalancing logic.
    // If a deposit to Binance has not been withdrawn after 30 minutes, it will get swept up by the Binance Sweeper
    // Finalizer because we set the TTL to 30 minutes when we deposited the funds and called
    // setBinanceDepositType().
  }

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

    // If there are any rebalances that are currently in the state of being bridged to Binance
    // (to subsequently be deposited into Binance), then the bridge adapter's getPendingRebalances() method will show
    // a virtual balance credit for the source token on the bridge destination chain
    // (i.e. Binance deposit entrypoint network in this case).
    // This credit plus this adapter's final destination chain credit (given to all pending orders) means that the
    // total virtual balance credit added for this one order will be too high (the order amount will be double counted).
    // Therefore, to counteract this double counting, we subtract each order's amount from the bridge destination chain's
    // virtual balance (i.e. Binance deposit entrypoint network in this case).
    const pendingBridgeToBinanceNetwork = await this._redisGetPendingBridgesPreDeposit();
    for (const cloid of pendingBridgeToBinanceNetwork) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { sourceChain, sourceToken, amountToTransfer } = orderDetails;
      const binanceDepositNetwork = await this._getEntrypointNetwork(sourceChain, sourceToken);
      const amountConverter = this._getAmountConverter(
        sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address,
        binanceDepositNetwork,
        this._getTokenInfo(sourceToken, binanceDepositNetwork).address
      );
      const convertedAmount = amountConverter(amountToTransfer);
      pendingRebalances[binanceDepositNetwork] ??= {};
      pendingRebalances[binanceDepositNetwork][sourceToken] = (
        pendingRebalances[binanceDepositNetwork][sourceToken] ?? bnZero
      ).sub(convertedAmount);
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Subtracting ${convertedAmount.toString()} ${sourceToken} from Binance deposit network ${binanceDepositNetwork} for intermediate bridge`,
      });
    }

    // Add virtual destination chain credits for all pending orders, so that the user of this class is aware that
    // we are in the process of sending tokens to the destination chain.
    const pendingOrders = await this._redisGetPendingOrders();
    if (pendingOrders.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Found ${pendingOrders.length} pending orders`,
        pendingOrders: pendingOrders,
      });
    }
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

    // Similar to how we treat orders that are in the state of being bridged to a Binance deposit network, we need to
    // also account for orders that are in the state of being bridged to a Binance withdrawal network (which may or may
    // not be subsequently bridged to a final destination chain). If the withdrawn amount has arrived at the withdrawal network,
    // then we should subtract the order's virtual balance from the withdrawal network.
    const pendingWithdrawals = await this._redisGetPendingWithdrawals();
    for (const cloid of pendingWithdrawals) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationChain, destinationToken, sourceChain, sourceToken, amountToTransfer } = orderDetails;
      const { matchingFill } = await this._getMatchingFillForCloid(cloid);
      assert(isDefined(matchingFill), "Matching fill should be defined for order with status PENDING_WITHDRAWAL");

      const binanceWithdrawalNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
      const initiatedWithdrawalId = await this._redisGetInitiatedWithdrawalId(cloid);
      if (!initiatedWithdrawalId) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
          message: `Cannot find initiated withdrawal for cloid ${cloid} which filled at ${matchingFill.time}, waiting`,
          cloid: cloid,
          matchingFill: matchingFill,
        });
        continue;
      } // Only proceed to modify virtual balances if there is an initiated withdrawal for this fill
      const { unfinalizedWithdrawals, finalizedWithdrawals } = await this._getBinanceWithdrawals(
        destinationToken,
        binanceWithdrawalNetwork,
        Math.floor(matchingFill.time / 1000) - 5 * 60 // Floor this so we can grab the initiated withdrawal data whose
        // ID we've already saved into Redis
      );
      const initiatedWithdrawalIsUnfinalized = unfinalizedWithdrawals.find(
        (withdrawal) => withdrawal.id === initiatedWithdrawalId
      );
      if (initiatedWithdrawalIsUnfinalized) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
          message: `Withdrawal for order ${cloid} for ${destinationToken} to binance withdrawal network ${binanceWithdrawalNetwork} has not finalized yet`,
          cloid: cloid,
          initiatedWithdrawalId,
        });
        continue;
      }

      // Order has finalized, subtract virtual balance from the binance withdrawal network:
      const withdrawalDetails = finalizedWithdrawals.find((withdrawal) => withdrawal.id === initiatedWithdrawalId);
      if (!withdrawalDetails) {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
          message: `Cannot find withdrawal details for cloid ${cloid} which filled at ${matchingFill.time}, waiting...`,
        });
        continue;
      }
      const amountConverter = this._getAmountConverter(
        sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address,
        destinationChain,
        this._getTokenInfo(destinationToken, destinationChain).address
      );
      const convertedAmount = amountConverter(amountToTransfer);
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Withdrawal for order ${cloid} has finalized, subtracting the order's virtual balance of ${convertedAmount.toString()} from binance withdrawal network ${binanceWithdrawalNetwork}`,
        cloid: cloid,
        orderDetails: orderDetails,
        withdrawalDetails,
      });
      pendingRebalances[binanceWithdrawalNetwork] ??= {};
      pendingRebalances[binanceWithdrawalNetwork][destinationToken] = (
        pendingRebalances[binanceWithdrawalNetwork][destinationToken] ?? bnZero
      ).sub(convertedAmount);
    }

    return pendingRebalances;
  }

  async getPendingOrders(): Promise<string[]> {
    return this._redisGetPendingOrders();
  }

  async initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber> {
    this._assertInitialized();
    this._assertRouteIsSupported(rebalanceRoute);
    const { sourceChain, sourceToken, destinationToken, destinationChain } = rebalanceRoute;

    const destinationCoin = await this._getAccountCoins(destinationToken);
    const destinationEntrypointNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
    const destinationBinanceNetwork = destinationCoin.networkList.find(
      (network) => network.name === BINANCE_NETWORKS[destinationEntrypointNetwork]
    );
    const { withdrawMin, withdrawMax } = destinationBinanceNetwork;
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
    const destinationTokenInfo = this._getTokenInfo(destinationToken, destinationEntrypointNetwork);
    const usesRoutePriceConversion = this._usesRoutePriceConversion(sourceToken, destinationToken);
    const latestPriceForRoute = usesRoutePriceConversion
      ? (await this._getLatestPrice(sourceToken, destinationToken, sourceChain, amountToTransfer)).latestPrice
      : undefined;
    const convertDestinationAmountToSourceAmount = async (amount: BigNumber) =>
      usesRoutePriceConversion
        ? this._convertRouteAmountToSourceAmount(
            sourceToken,
            sourceChain,
            destinationToken,
            destinationEntrypointNetwork,
            amount,
            latestPriceForRoute
          )
        : this._getAmountConverter(
            destinationEntrypointNetwork,
            this._getTokenInfo(destinationToken, destinationEntrypointNetwork).address,
            sourceChain,
            sourceTokenInfo.address
          )(amount);

    // Make sure that the amount to transfer will be larger than the minimum withdrawal size after expected fees.
    const expectedCost = await this.getEstimatedCost(rebalanceRoute, amountToTransfer, false);
    const expectedAmountToWithdraw = amountToTransfer.sub(expectedCost);
    const minimumWithdrawalSize = await convertDestinationAmountToSourceAmount(
      toBNWei(Number(withdrawMin) + 1, destinationTokenInfo.decimals)
    );
    const maximumWithdrawalSize = await convertDestinationAmountToSourceAmount(
      toBNWei(withdrawMax, destinationTokenInfo.decimals)
    );
    if (expectedAmountToWithdraw.lt(minimumWithdrawalSize)) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.initializeRebalance",
        message: `Expected amount to withdraw ${expectedAmountToWithdraw.toString()} is less than minimum withdrawal size ${minimumWithdrawalSize.toString()} on Binance destination chain ${destinationEntrypointNetwork}`,
      });
      return bnZero;
    }
    if (expectedAmountToWithdraw.gt(maximumWithdrawalSize)) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.initializeRebalance",
        message: `Expected amount to withdraw ${expectedAmountToWithdraw.toString()} is greater than maximum withdrawal size ${maximumWithdrawalSize.toString()} on Binance destination chain ${destinationEntrypointNetwork}`,
      });
      return bnZero;
    }

    // TODO: The amount transferred here might produce dust due to the rounding required to meet the minimum order
    // tick size. We try not to precompute the size required to place an order here because the price might change
    // and the amount transferred in might be insufficient to place the order later on, producing more dust or an
    // error.
    const spotMarketMeta = await this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const minimumOrderSize =
      spotMarketMeta.isBuy && usesRoutePriceConversion
        ? await this._convertRouteAmountToSourceAmount(
            sourceToken,
            sourceChain,
            destinationToken,
            destinationChain,
            toBNWei(spotMarketMeta.minimumOrderSize, this._getTokenInfo(destinationToken, destinationChain).decimals),
            latestPriceForRoute
          )
        : toBNWei(spotMarketMeta.minimumOrderSize, sourceTokenInfo.decimals);
    if (amountToTransfer.lt(minimumOrderSize)) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.initializeRebalance",
        message: `Amount to transfer ${amountToTransfer.toString()} is less than minimum order size ${minimumOrderSize.toString()}`,
      });
      return bnZero;
    }

    const cloid = await this._redisGetNextCloid();

    // Select which chain we will be depositing and withdrawing the source tokens in to and out of Binance from.
    // If the chains are Binance networks, then we use the chain itself. Otherwise, we use the default Binance network
    // of Arbitrum, which is selected for convenience because it is both a CCTP and OFT network as well as a
    // Binance network with good stability.
    const binanceDepositNetwork = await this._getEntrypointNetwork(sourceChain, sourceToken);
    const requiresBridgeBeforeDeposit = binanceDepositNetwork !== sourceChain;
    if (requiresBridgeBeforeDeposit) {
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
        return bnZero;
      }
      this.logger.info({
        at: "BinanceStablecoinSwapAdapter.initializeRebalance",
        message: `🍻 Creating new order ${cloid} by first bridging ${sourceToken} into ${getNetworkName(
          binanceDepositNetwork
        )} from ${getNetworkName(sourceChain)}`,
        destinationToken,
        destinationChain: getNetworkName(destinationChain),
        amountToTransfer: amountToTransfer.toString(),
      });
      const amountReceivedFromBridge = await this._bridgeToChain(
        sourceToken,
        sourceChain,
        binanceDepositNetwork,
        amountToTransfer
      );
      await this._redisCreateOrder(cloid, STATUS.PENDING_BRIDGE_PRE_DEPOSIT, rebalanceRoute, amountReceivedFromBridge);
      return amountReceivedFromBridge;
    } else {
      this.logger.info({
        at: "BinanceStablecoinSwapAdapter.initializeRebalance",
        message: `🍻 Creating new order ${cloid} by first transferring ${amountToTransfer.toString()} ${sourceToken} into Binance from ${getNetworkName(
          sourceChain
        )}`,
        destinationToken,
        destinationChain: getNetworkName(destinationChain),
      });
      await this._depositToBinance(sourceToken, sourceChain, amountToTransfer);
      await this._redisCreateOrder(cloid, STATUS.PENDING_DEPOSIT, rebalanceRoute, amountToTransfer);
      return amountToTransfer;
    }
  }

  async getEstimatedCost(
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    debugLog: boolean
  ): Promise<BigNumber> {
    this._assertRouteIsSupported(rebalanceRoute);
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;
    const spotMarketMeta = await this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    // Commission is denominated in percentage points.
    const tradeFeePct = (await this._getTradeFees()).find(
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

    const { latestPrice } = await this._getLatestPrice(sourceToken, destinationToken, sourceChain, amountToTransfer);
    const usesRoutePriceConversion = this._usesRoutePriceConversion(sourceToken, destinationToken);
    const withdrawFeeConvertedToSourceToken = usesRoutePriceConversion
      ? await this._convertRouteAmountToSourceAmount(
          sourceToken,
          sourceChain,
          destinationToken,
          destinationEntrypointNetwork,
          withdrawFee,
          latestPrice
        )
      : this._getAmountConverter(
          destinationEntrypointNetwork,
          this._getTokenInfo(destinationToken, destinationEntrypointNetwork).address,
          sourceChain,
          this._getTokenInfo(sourceToken, sourceChain).address
        )(withdrawFee);

    const spreadPct = usesRoutePriceConversion ? 0 : spotMarketMeta.isBuy ? latestPrice - 1 : 1 - latestPrice;
    const spreadFee = usesRoutePriceConversion
      ? bnZero
      : toBNWei(spreadPct.toFixed(18), 18).mul(amountToTransfer).div(toBNWei(1, 18));

    // Bridge to Binance deposit network Fee:
    let bridgeToBinanceFee = bnZero;
    const binanceDepositNetwork = await this._getEntrypointNetwork(sourceChain, sourceToken);
    if (binanceDepositNetwork !== sourceChain) {
      const _rebalanceRoute = { ...rebalanceRoute, destinationChain: binanceDepositNetwork };
      if (
        sourceToken === "USDT" &&
        this.oftAdapter.supportsRoute({ ..._rebalanceRoute, destinationToken: "USDT", adapter: "oft" })
      ) {
        bridgeToBinanceFee = await this.oftAdapter.getEstimatedCost(
          { ..._rebalanceRoute, destinationToken: "USDT", adapter: "oft" },
          amountToTransfer
        );
      } else if (
        sourceToken === "USDC" &&
        this.cctpAdapter.supportsRoute({ ..._rebalanceRoute, destinationToken: "USDC", adapter: "cctp" })
      ) {
        bridgeToBinanceFee = await this.cctpAdapter.getEstimatedCost(
          { ..._rebalanceRoute, destinationToken: "USDC", adapter: "cctp" },
          amountToTransfer
        );
      }
    }

    // Bridge from Binance withdrawal network fee:
    let bridgeFromBinanceFee = bnZero;
    const binanceWithdrawNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);
    if (binanceWithdrawNetwork !== destinationChain) {
      const _rebalanceRoute = { ...rebalanceRoute, sourceChain: binanceWithdrawNetwork };
      if (
        destinationToken === "USDT" &&
        this.oftAdapter.supportsRoute({ ..._rebalanceRoute, sourceToken: "USDT", adapter: "oft" })
      ) {
        bridgeFromBinanceFee = await this.oftAdapter.getEstimatedCost(
          { ..._rebalanceRoute, sourceToken: "USDT", adapter: "oft" },
          amountToTransfer
        );
      } else if (
        destinationToken === "USDC" &&
        this.cctpAdapter.supportsRoute({ ..._rebalanceRoute, sourceToken: "USDC", adapter: "cctp" })
      ) {
        bridgeFromBinanceFee = await this.cctpAdapter.getEstimatedCost(
          { ..._rebalanceRoute, sourceToken: "USDC", adapter: "cctp" },
          amountToTransfer
        );
      }
    }

    // The only time we add an opportunity cost of capital component is when we require rebalancing via OFT from HyperEVM
    // because this is the only route amongst all CCTP/OFT routes that takes longer than ~20 minutes to complete. It takes
    // 11 hours and this is so much larger than the default bridging time that we need to charge something for the opportunity cost of capital.
    // @todo a better way to do this might be to use historical fills to calculate the relayer's
    // latest profitability % to forecast the opportunity cost of capital.
    const requiresOftBridgeFromHyperevm =
      sourceChain === CHAIN_IDs.HYPEREVM &&
      sourceToken === "USDT" &&
      (await this._getEntrypointNetwork(sourceChain, sourceToken)) !== CHAIN_IDs.HYPEREVM;
    const opportunityCostOfCapitalPct = requiresOftBridgeFromHyperevm
      ? this._getOpportunityCostOfCapitalPctForRebalanceTime(11 * 60 * 60 * 1000)
      : bnZero;
    const opportunityCostOfCapitalFixed = toBNWei(opportunityCostOfCapitalPct, 18)
      .mul(amountToTransfer)
      .div(toBNWei(100, 18));

    const totalFee = tradeFee
      .add(withdrawFeeConvertedToSourceToken)
      .add(spreadFee)
      .add(bridgeToBinanceFee)
      .add(bridgeFromBinanceFee)
      .add(opportunityCostOfCapitalFixed);

    if (debugLog) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getEstimatedCost",
        message: `Calculating total fees for rebalance route ${sourceToken} on ${getNetworkName(sourceChain)} to ${destinationToken} on ${getNetworkName(destinationChain)} with amount to transfer ${amountToTransfer.toString()}`,
        tradeFeePct,
        tradeFee: tradeFee.toString(),
        withdrawFeeConvertedToSourceToken: withdrawFeeConvertedToSourceToken.toString(),
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

  // ////////////////////////////////////////////////////////////
  // PRIVATE BINANCE HELPER METHODS
  // ////////////////////////////////////////////////////////////

  private async _getAccountCoins(symbol: string, skipCache = false): Promise<Coin> {
    const binanceSymbol = resolveBinanceCoinSymbol(symbol);
    const cacheKey = "binance-account-coins";

    type ParsedAccountCoins = Awaited<ReturnType<typeof getAccountCoins>>;
    let accountCoins: ParsedAccountCoins | undefined;
    if (!skipCache) {
      const cachedAccountCoins = await this.redisCache.get<string>(cacheKey);
      if (cachedAccountCoins) {
        accountCoins = JSON.parse(cachedAccountCoins) as ParsedAccountCoins;
      }
    }
    if (!accountCoins) {
      accountCoins = await getAccountCoins(this.binanceApiClient);
      // Reset cache if we've fetched a new API response.
      await this.redisCache.set(cacheKey, JSON.stringify(accountCoins)); // Use default TTL which is a long time as
      // the entry for this coin is not expected to change frequently.
    }

    const coin = accountCoins.find((coin) => coin.symbol === binanceSymbol);
    assert(coin, `Coin ${binanceSymbol} not found in account coins`);
    return coin;
  }

  private async _getEntrypointNetwork(chainId: number, token: string): Promise<number> {
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

  private async _depositToBinance(sourceToken: string, sourceChain: number, amountToDeposit: BigNumber): Promise<void> {
    assert(isDefined(BINANCE_NETWORKS[sourceChain]), "Source chain should be a Binance network");
    const depositAddress = await this.binanceApiClient.depositAddress({
      coin: resolveBinanceCoinSymbol(sourceToken),
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
    const txnHash = await this._submitTransaction(txn);
    // Set the TTL to 30 minutes so that the Binance sweeper finalizer only attempts to pull back these deposited
    // funds after 30 minutes. If the swap hasn't occurred in 30 mins then something has gone wrong.
    await setBinanceDepositType(sourceChain, txnHash, BinanceTransactionType.SWAP, 30 * 60);
    this.logger.debug({
      at: "BinanceStablecoinSwapAdapter._depositToBinance",
      message: `Deposited ${amountReadable} ${sourceToken} to Binance from chain ${getNetworkName(sourceChain)}`,
      redisDepositTypeKey: getBinanceTransactionTypeKey(sourceChain, txnHash),
    });
  }

  private async _getBinanceBalance(token: string): Promise<number> {
    const coin = await this._getAccountCoins(token, true); // Skip cache so we load the balance fresh each time.
    return Number(coin.balance);
  }

  private async _getSymbol(sourceToken: string, destinationToken: string) {
    const sourceAsset = resolveBinanceCoinSymbol(sourceToken);
    const destinationAsset = resolveBinanceCoinSymbol(destinationToken);
    this.exchangeInfoPromise ??= this.binanceApiClient.exchangeInfo();
    const symbol = (await this.exchangeInfoPromise).symbols.find((symbols) => {
      return (
        symbols.symbol === `${sourceAsset}${destinationAsset}` || symbols.symbol === `${destinationAsset}${sourceAsset}`
      );
    });
    assert(symbol, `No market found for ${sourceAsset} and ${destinationAsset}`);
    return symbol;
  }

  private async _getLatestPrice(
    sourceToken: string,
    destinationToken: string,
    sourceChain: number,
    amountToTransfer: BigNumber
  ): Promise<{ latestPrice: number; slippagePct: number }> {
    const symbol = await this._getSymbol(sourceToken, destinationToken);
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
    const book = await this._getOrderBook(symbol.symbol);
    const spotMarketMeta = await this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const sideOfBookToTraverse = spotMarketMeta.isBuy ? book.asks : book.bids;
    assert(sideOfBookToTraverse.length > 0, `Order book is empty for ${symbol.symbol}`);
    const bestPx = Number(sideOfBookToTraverse[0].price);
    let szFilledSoFar = bnZero;
    const maxPxReached = sideOfBookToTraverse.find((level) => {
      // Note: sz is always denominated in the base asset, so if we are buying, then the amountToTransfer (i.e.
      // the amount that we want to buy of the base asset) is denominated in the quote asset and we need to convert it
      // into the base asset.
      const sz = spotMarketMeta.isBuy ? Number(level.quantity) * Number(level.price) : Number(level.quantity);
      const szWei = toBNWei(truncate(sz, sourceTokenInfo.decimals), sourceTokenInfo.decimals);
      if (szWei.gte(amountToTransfer)) {
        return true;
      }
      szFilledSoFar = szFilledSoFar.add(szWei);
    });
    const terminalLevel = maxPxReached ?? sideOfBookToTraverse[sideOfBookToTraverse.length - 1];
    if (!maxPxReached) {
      this.logger.warn({
        at: "BinanceStablecoinSwapAdapter._getLatestPrice",
        message: "Order size exceeds visible Binance order book depth; using deepest visible level",
        market: symbol.symbol,
        sourceToken,
        destinationToken,
        requestedSizeNative: amountToTransfer.toString(),
        visibleDepthNative: szFilledSoFar.toString(),
      });
    }
    const latestPrice = Number(Number(terminalLevel.price).toFixed(spotMarketMeta.pxDecimals));
    const slippagePct = Math.abs((latestPrice - bestPx) / bestPx) * 100;
    return { latestPrice, slippagePct };
  }

  private async _getOrderBook(symbol: string): Promise<Awaited<ReturnType<Binance["book"]>>> {
    const cachedBook = this.orderBookSnapshotBySymbol.get(symbol);
    if (cachedBook && Date.now() - cachedBook.fetchedAtMs <= BinanceStablecoinSwapAdapter.ORDER_BOOK_CACHE_TTL_MS) {
      return cachedBook.book;
    }

    const existingPromise = this.orderBookPromiseBySymbol.get(symbol);
    if (existingPromise !== undefined) {
      return existingPromise;
    }

    const promise = this._fetchOrderBook(symbol).then((book) => {
      this.orderBookSnapshotBySymbol.set(symbol, {
        fetchedAtMs: Date.now(),
        book,
      });
      return book;
    });
    this.orderBookPromiseBySymbol.set(symbol, promise);
    void promise.finally(() => {
      if (this.orderBookPromiseBySymbol.get(symbol) === promise) {
        this.orderBookPromiseBySymbol.delete(symbol);
      }
    });

    return promise;
  }

  private async _fetchOrderBook(
    symbol: string,
    nRetries = 0,
    maxRetries = 3
  ): Promise<Awaited<ReturnType<Binance["book"]>>> {
    try {
      return await this.binanceApiClient.book({ symbol, limit: 5000 });
    } catch (error) {
      if (nRetries >= maxRetries) {
        throw error;
      }

      await delay(2 ** nRetries + Math.random());
      return this._fetchOrderBook(symbol, nRetries + 1, maxRetries);
    }
  }

  private _getQuantityForOrder(
    sourceToken: string,
    sourceChain: number,
    destinationToken: string,
    destinationChain: number,
    amountToTransfer: BigNumber,
    price: number
  ): Promise<number> {
    return this._getSpotMarketMetaForRoute(sourceToken, destinationToken).then(async (spotMarketMeta) => {
      const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
      const amountToOrder = spotMarketMeta.isBuy
        ? await this._estimateDestinationAmountForRoute(
            sourceToken,
            sourceChain,
            destinationToken,
            destinationChain,
            amountToTransfer,
            price
          )
        : amountToTransfer;
      const decimals = spotMarketMeta.isBuy
        ? this._getTokenInfo(destinationToken, destinationChain).decimals
        : sourceTokenInfo.decimals;
      const szNumber = Number(fromWei(amountToOrder, decimals));
      const szFormatted = truncate(szNumber, spotMarketMeta.szDecimals);
      assert(
        szFormatted >= spotMarketMeta.minimumOrderSize,
        `size of order ${szFormatted} is less than minimum order size ${spotMarketMeta.minimumOrderSize}`
      );
      return szFormatted;
    });
  }

  private async _getSpotMarketMetaForRoute(sourceToken: string, destinationToken: string): Promise<SPOT_MARKET_META> {
    const routeName = `${sourceToken}-${destinationToken}`;
    const existingPromise = this.spotMarketMetaPromiseByRoute.get(routeName);
    if (existingPromise !== undefined) {
      return existingPromise;
    }

    const promise = this._getSymbol(sourceToken, destinationToken).then((symbol) =>
      deriveBinanceSpotMarketMeta(sourceToken, destinationToken, symbol)
    );
    this.spotMarketMetaPromiseByRoute.set(routeName, promise);
    void promise.finally(() => {
      if (this.spotMarketMetaPromiseByRoute.get(routeName) === promise) {
        this.spotMarketMetaPromiseByRoute.delete(routeName);
      }
    });
    return promise;
  }

  private _usesRoutePriceConversion(sourceToken: string, destinationToken: string): boolean {
    return resolveBinanceCoinSymbol(sourceToken) !== resolveBinanceCoinSymbol(destinationToken);
  }

  private async _estimateDestinationAmountForRoute(
    sourceToken: string,
    sourceChain: number,
    destinationToken: string,
    destinationChain: number,
    amountToTransfer: BigNumber,
    price: number
  ): Promise<BigNumber> {
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
    const destinationTokenInfo = this._getTokenInfo(destinationToken, destinationChain);
    const spotMarketMeta = await this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    return convertBinanceRouteAmount({
      amount: amountToTransfer,
      sourceTokenDecimals: sourceTokenInfo.decimals,
      destinationTokenDecimals: destinationTokenInfo.decimals,
      isBuy: spotMarketMeta.isBuy,
      price,
      direction: "source-to-destination",
    });
  }

  private async _convertRouteAmountToSourceAmount(
    sourceToken: string,
    sourceChain: number,
    destinationToken: string,
    destinationChain: number,
    amountInDestinationToken: BigNumber,
    price: number
  ): Promise<BigNumber> {
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
    const destinationTokenInfo = this._getTokenInfo(destinationToken, destinationChain);
    const spotMarketMeta = await this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    return convertBinanceRouteAmount({
      amount: amountInDestinationToken,
      sourceTokenDecimals: sourceTokenInfo.decimals,
      destinationTokenDecimals: destinationTokenInfo.decimals,
      isBuy: spotMarketMeta.isBuy,
      price,
      direction: "destination-to-source",
    });
  }

  private async _getTradeFees(): ReturnType<Binance["tradeFee"]> {
    this.tradeFeesPromise ??= this.binanceApiClient.tradeFee({ useServerTime: true });
    return this.tradeFeesPromise;
  }

  private async _getMatchingFillForCloid(
    cloid: string
  ): Promise<{ matchingFill: QueryOrderResult; expectedAmountToReceive: string } | undefined> {
    const orderDetails = await this._redisGetOrderDetails(cloid);
    const spotMarketMeta = await this._getSpotMarketMetaForRoute(
      orderDetails.sourceToken,
      orderDetails.destinationToken
    );
    const allOrders = await this.binanceApiClient.allOrders({
      symbol: spotMarketMeta.symbol,
    });
    const matchingFill = allOrders.find((order) => order.clientOrderId === cloid && order.status === "FILLED");
    const expectedAmountToReceive = spotMarketMeta.isBuy ? matchingFill.executedQty : matchingFill.cummulativeQuoteQty;
    return { matchingFill, expectedAmountToReceive };
  }

  private async _placeMarketOrder(cloid: string, orderDetails: OrderDetails): Promise<void> {
    const { sourceToken, sourceChain, destinationToken, destinationChain, amountToTransfer } = orderDetails;
    const latestPx = (await this._getLatestPrice(sourceToken, destinationToken, sourceChain, amountToTransfer))
      .latestPrice;
    const szForOrder = await this._getQuantityForOrder(
      sourceToken,
      sourceChain,
      destinationToken,
      destinationChain,
      amountToTransfer,
      latestPx
    );
    const spotMarketMeta = await this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
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
    this.logger.info({
      at: "BinanceStablecoinSwapAdapter._placeMarketOrder",
      message: `🎰 Submitted new market order for cloid ${cloid} with size ${szForOrder}`,
      orderStruct,
      response,
    });
  }

  private async _getInitiatedBinanceWithdrawals(
    token: string,
    chain: number,
    startTime: number
  ): Promise<BinanceWithdrawal[]> {
    const binanceToken = resolveBinanceCoinSymbol(token);
    assert(isDefined(BINANCE_NETWORKS[chain]), "Chain should be a Binance network");
    return (await getBinanceWithdrawals(this.binanceApiClient, binanceToken, startTime)).filter(
      (withdrawal) =>
        withdrawal.coin === binanceToken &&
        withdrawal.network === BINANCE_NETWORKS[chain] &&
        withdrawal.recipient === this.baseSignerAddress.toNative() &&
        withdrawal.status > 4
      // @dev (0: Email Sent, 1: Cancelled 2: Awaiting Approval, 3: Rejected, 4: Processing, 5: Failure, 6: Completed)
    );
  }

  private async _getBinanceWithdrawals(
    destinationToken: string,
    destinationChain: number,
    startTimeSeconds: number
  ): Promise<{ unfinalizedWithdrawals: BinanceWithdrawal[]; finalizedWithdrawals: BinanceWithdrawal[] }> {
    assert(isDefined(BINANCE_NETWORKS[destinationChain]), "Destination chain should be a Binance network");
    const provider = await getProvider(destinationChain);
    // @dev Binance withdrawals are fast, so setting a lookback of 6 hours should capture any unfinalized withdrawals.
    const withdrawalInitiatedLookbackPeriodSeconds = 6 * 60 * 60;
    const withdrawalInitiatedFromTimestampSeconds = startTimeSeconds - withdrawalInitiatedLookbackPeriodSeconds;
    const eventSearchConfig = await this._getEventSearchConfig(
      destinationChain,
      withdrawalInitiatedFromTimestampSeconds
    );
    const destinationTokenContract = new Contract(
      this._getTokenInfo(destinationToken, destinationChain).address.toNative(),
      ERC20.abi,
      this.baseSigner.connect(provider)
    );
    const destinationChainTransferEvents = await paginatedEventQuery(
      destinationTokenContract,
      destinationTokenContract.filters.Transfer(null, this.baseSignerAddress.toNative()),
      eventSearchConfig
    );
    const initiatedWithdrawals = await this._getInitiatedBinanceWithdrawals(
      destinationToken,
      destinationChain,
      startTimeSeconds * 1000
    );

    const finalizedWithdrawals: BinanceWithdrawal[] = [];
    const unfinalizedWithdrawals: BinanceWithdrawal[] = [];
    for (const initiated of initiatedWithdrawals) {
      const withdrawalAmount = toBNWei(
        initiated.amount, // @dev This should be the post-withdrawal fee amount so it should match perfectly
        // with the finalized amount.
        this._getTokenInfo(destinationToken, destinationChain).decimals
      );
      const matchingFinalizedAmount = destinationChainTransferEvents.find(
        (finalized) =>
          !finalizedWithdrawals.some((finalizedWithdrawal) => finalizedWithdrawal.txId === finalized.transactionHash) &&
          finalized.args.value.toString() === withdrawalAmount.toString()
      );
      if (matchingFinalizedAmount) {
        finalizedWithdrawals.push(initiated);
      } else {
        unfinalizedWithdrawals.push(initiated);
      }
    }
    return { unfinalizedWithdrawals, finalizedWithdrawals };
  }

  private _redisGetInitiatedWithdrawalKey(cloid: string): string {
    return this.REDIS_KEY_INITIATED_WITHDRAWALS + ":" + cloid;
  }

  private async _redisGetInitiatedWithdrawalId(cloid: string): Promise<string> {
    const initiatedWithdrawalKey = this._redisGetInitiatedWithdrawalKey(cloid);
    const initiatedWithdrawal = await this.redisCache.get<string>(initiatedWithdrawalKey);
    return initiatedWithdrawal;
  }

  protected async _bridgeToChain(
    token: string,
    originChain: number,
    destinationChain: number,
    expectedAmountToTransfer: BigNumber
  ): Promise<BigNumber> {
    switch (token) {
      case "USDT":
        return await this.oftAdapter.initializeRebalance(
          {
            sourceChain: originChain,
            destinationChain,
            sourceToken: "USDT",
            destinationToken: "USDT",
            adapter: "oft",
          },
          expectedAmountToTransfer
        );
      case "USDC":
        return await this.cctpAdapter.initializeRebalance(
          {
            sourceChain: originChain,
            destinationChain,
            sourceToken: "USDC",
            destinationToken: "USDC",
            adapter: "cctp",
          },
          expectedAmountToTransfer
        );
      default:
        throw new Error(`Should never happen: Unsupported bridge for token: ${token}`);
    }
  }

  private async _withdraw(
    cloid: string,
    quantity: number,
    destinationToken: string,
    destinationChain: number
  ): Promise<void> {
    const destinationEntrypointNetwork = await this._getEntrypointNetwork(destinationChain, destinationToken);

    // We need to truncate the amount to withdraw to the destination chain's decimal places.
    const destinationTokenInfo = this._getTokenInfo(destinationToken, destinationEntrypointNetwork);
    const amountToWithdraw = truncate(quantity, destinationTokenInfo.decimals);
    const withdrawalId = await this.binanceApiClient.withdraw({
      coin: resolveBinanceCoinSymbol(destinationToken),
      address: this.baseSignerAddress.toNative(),
      amount: Number(amountToWithdraw),
      network: BINANCE_NETWORKS[destinationEntrypointNetwork],
      transactionFeeFlag: false,
    });
    const initiatedWithdrawalKey = this._redisGetInitiatedWithdrawalKey(cloid);
    await this.redisCache.set(initiatedWithdrawalKey, withdrawalId.id);
    await setBinanceWithdrawalType(destinationEntrypointNetwork, withdrawalId.id, BinanceTransactionType.SWAP);
    this.logger.info({
      at: "BinanceStablecoinSwapAdapter._withdraw",
      message: `🏧 Withdrew ${quantity} ${destinationToken} from Binance to withdrawal network ${getNetworkName(
        destinationEntrypointNetwork
      )} for order cloid ${cloid}`,
      redisWithdrawalIdKey: initiatedWithdrawalKey,
      redisWithdrawalTypeKey: getBinanceTransactionTypeKey(destinationEntrypointNetwork, withdrawalId.id),
      finalDestinationChain: destinationChain,
    });
  }
}
