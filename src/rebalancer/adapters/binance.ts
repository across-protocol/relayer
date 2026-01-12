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
  isWeekday,
  paginatedEventQuery,
  setBinanceDepositType,
  setBinanceWithdrawalType,
  Signer,
  toBNWei,
  truncate,
  winston,
} from "../../utils";
import { RebalanceRoute } from "../rebalancer";
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

  REDIS_PREFIX = "binance-stablecoin-swap:";

  REDIS_KEY_PENDING_ORDER = this.REDIS_PREFIX + "pending-order";
  REDIS_KEY_INITIATED_WITHDRAWALS = this.REDIS_PREFIX + "initiated-withdrawals";

  // Key used to query latest cloid that uniquely identifies orders. Also used to set cloids when placing HL orders.
  REDIS_KEY_LATEST_NONCE = this.REDIS_PREFIX + "latest-nonce";

  REDIS_KEY_PENDING_BRIDGE_TO_BINANCE_NETWORK = this.REDIS_PREFIX + "pending-bridge-to-binance-network";
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
    super(logger, config, baseSigner);
  }

  // ////////////////////////////////////////////////////////////
  // PUBLIC METHODS
  // ////////////////////////////////////////////////////////////

  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
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
      assert(
        destinationEntrypointNetwork === destinationChain ||
          this._chainIsBridgeable(destinationChain, destinationToken),
        `Destination chain ${getNetworkName(
          destinationChain
        )} is not a valid final destination chain for token ${destinationToken}`
      );
      assert(
        sourceEntrypointNetwork === sourceChain || this._chainIsBridgeable(sourceChain, sourceToken),
        `Source chain ${getNetworkName(sourceChain)} is not a valid source chain for token ${sourceToken}`
      );
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
        // Delay a bit after depositing to Binance so we can, in the best case, place a market order immediately
        // after we allow the deposit to confirm and be reflected in the Binance balance.
        await this._wait(10);
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
        await this._wait(5);
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
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Order ${cloid} has finalized withdrawing to ${binanceWithdrawalNetwork}; bridging ${destinationToken} from ${binanceWithdrawalNetwork} to final destination chain ${destinationChain} and deleting order details from Redis!`,
          requiredWithdrawAmount: withdrawAmountWei.toString(),
          destinationToken,
          withdrawalDetails,
        });
        await this._bridgeToChain(destinationToken, binanceWithdrawalNetwork, destinationChain, withdrawAmountWei);
      } else {
        this.logger.debug({
          at: "BinanceStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Deleting order details from Redis with cloid ${cloid} because its withdrawal has finalized to the final destination chain ${destinationChain}!`,
          withdrawalDetails,
        });
      }
      // We no longer need this order information, so we can delete it.
      await this._redisDeleteOrder(cloid, STATUS.PENDING_WITHDRAWAL);
    }
  }

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

    // If there are any rebalances that are currently in the state of being bridged to a Binance deposit network
    // (to subsequently be deposited into Binance), then we should check if their bridged amounts have arrived at the
    // deposit network yet. If they have, then the network's balance will be higher than we want to show, so we should
    // subtract each order's expected deposit amount from that network's balance.
    const pendingBridgeToBinanceNetwork = await this._redisGetPendingBridgeToBinanceNetwork();
    if (pendingBridgeToBinanceNetwork.length > 0) {
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Pending bridge to Binance deposit network cloids: ${pendingBridgeToBinanceNetwork.join(", ")}`,
      });
    }
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
            // @dev amountToTransfer should be exactly equal to the amount bridged, because of the way that we save
            // the amountToTransfer in _bridgeToChain and the subsequent call _redisCreateOrder.
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
                message: `Order cloid ${cloid} is possibly pending finalization from ${sourceChain} to binance deposit network ${binanceDepositNetwork} still (remaining pending amount: ${pendingRebalanceAmount.toString()} ${sourceToken}, order expected amount: ${convertedOrderAmount.toString()})`,
              });

              pendingRebalanceAmount = pendingRebalanceAmount.sub(convertedOrderAmount);
              continue;
            }

            // Order has finalized, subtract virtual balance from the binance deposit network:
            this.logger.debug({
              at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
              message: `Subtracting ${convertedOrderAmount.toString()} ${sourceToken} for order cloid ${cloid} that has finalized bridging from ${sourceChain} to binance deposit network ${binanceDepositNetwork}`,
            });
            pendingRebalances[binanceDepositNetwork] ??= {};
            pendingRebalances[binanceDepositNetwork][sourceToken] = (
              pendingRebalances[binanceDepositNetwork][sourceToken] ?? bnZero
            ).sub(convertedOrderAmount);
          }
        }
      });
    });

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
      const { destinationChain, destinationToken } = orderDetails;
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
      this.logger.debug({
        at: "BinanceStablecoinSwapAdapter.getPendingRebalances",
        message: `Withdrawal for order ${cloid} has finalized, subtracting the order's virtual balance of ${orderDetails.amountToTransfer.toString()} from binance withdrawal network ${binanceWithdrawalNetwork}`,
        cloid: cloid,
        orderDetails: orderDetails,
        withdrawalDetails,
      });
      pendingRebalances[binanceWithdrawalNetwork] ??= {};
      pendingRebalances[binanceWithdrawalNetwork][destinationToken] = (
        pendingRebalances[binanceWithdrawalNetwork][destinationToken] ?? bnZero
      ).sub(orderDetails.amountToTransfer);
    }

    return pendingRebalances;
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

    // - Opportunity cost of capital when source chain is 999 and token is USDT. The rudimentary logic here is to assume 4bps when the
    // OFT rebalance would end on a weekday.
    //  @todo a better way to do this might be to use historical fills to calculate the relayer's
    // latest profitability % to forecast the opportunity cost of capital.
    const requiresOftBridgeFromHyperevm =
      sourceChain === CHAIN_IDs.HYPEREVM &&
      sourceToken === "USDT" &&
      (await this._getEntrypointNetwork(sourceChain, sourceToken)) !== CHAIN_IDs.HYPEREVM;
    const oftRebalanceEndTime =
      new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).getTime() + 11 * 60 * 60 * 1000;
    const opportunityCostOfCapitalBps =
      requiresOftBridgeFromHyperevm && (isWeekday() || isWeekday(new Date(oftRebalanceEndTime))) ? 4 : 0;
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

  // ////////////////////////////////////////////////////////////
  // PRIVATE BINANCE HELPER METHODS
  // ////////////////////////////////////////////////////////////

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
    const txnHash = await this._submitTransaction(txn);
    await setBinanceDepositType(sourceChain, txnHash, BinanceTransactionType.SWAP, this.redisCache);
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
    const symbol = (await this.binanceApiClient.exchangeInfo()).symbols.find((symbols) => {
      return (
        symbols.symbol === `${sourceToken}${destinationToken}` || symbols.symbol === `${destinationToken}${sourceToken}`
      );
    });
    assert(symbol, `No market found for ${sourceToken} and ${destinationToken}`);
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
      const szWei = toBNWei(truncate(sz, sourceTokenInfo.decimals), sourceTokenInfo.decimals);
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

  private _getQuantityForOrder(
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
    // Floor this number so we can guarantee that we have enough balance to place the order:
    const szNumber = Number(fromWei(sz, sourceTokenInfo.decimals));
    const szFormatted = truncate(szNumber, spotMarketMeta.szDecimals);
    assert(
      szFormatted >= spotMarketMeta.minimumOrderSize,
      `size of order ${szFormatted} is less than minimum order size ${spotMarketMeta.minimumOrderSize}`
    );
    return szFormatted;
  }

  private _getSpotMarketMetaForRoute(sourceToken: string, destinationToken: string): SPOT_MARKET_META {
    const name = `${sourceToken}-${destinationToken}`;
    return this.spotMarketMeta[name];
  }

  private async _getMatchingFillForCloid(
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

  private async _placeMarketOrder(cloid: string, orderDetails: OrderDetails): Promise<void> {
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

  private async _getInitiatedBinanceWithdrawals(
    token: string,
    chain: number,
    startTime: number
  ): Promise<BinanceWithdrawal[]> {
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
    // @todo: Make sure that the finalized event query time range is after the initiated event query, otherwise we might
    // see false positives of unfinalized withdrawals just because we're not looking at the right time range for the
    // the finalized events. The assumption we want to maintain is that we see all possible finalized events
    // for the chosen inititated events.
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
      coin: destinationToken,
      address: this.baseSignerAddress.toNative(),
      amount: Number(amountToWithdraw),
      network: BINANCE_NETWORKS[destinationEntrypointNetwork],
      transactionFeeFlag: false,
    });
    const initiatedWithdrawalKey = this._redisGetInitiatedWithdrawalKey(cloid);
    await this.redisCache.set(initiatedWithdrawalKey, withdrawalId.id);
    await setBinanceWithdrawalType(
      destinationEntrypointNetwork,
      withdrawalId.id,
      BinanceTransactionType.SWAP,
      this.redisCache
    );
    this.logger.info({
      at: "BinanceStablecoinSwapAdapter._withdraw",
      message: `Withdrew ${quantity} ${destinationToken} from Binance to withdrawal network ${getNetworkName(
        destinationEntrypointNetwork
      )} for order cloid ${cloid}`,
      redisWithdrawalIdKey: initiatedWithdrawalKey,
      redisWithdrawalTypeKey: getBinanceTransactionTypeKey(destinationEntrypointNetwork, withdrawalId.id),
      finalDestinationChain: destinationChain,
    });
  }

  // ////////////////////////////////////////////////////////////
  // PRIVATE REDIS HELPER FUNCTIONS
  // ////////////////////////////////////////////////////////////

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

  private async _redisGetPendingBridgeToBinanceNetwork(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_BRIDGE_TO_BINANCE_NETWORK);
    return sMembers;
  }

  private async _redisGetPendingDeposits(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_DEPOSIT);
    return sMembers;
  }

  private async _redisGetPendingSwaps(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_SWAP);
    return sMembers;
  }

  private async _redisGetPendingWithdrawals(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_WITHDRAWAL);
    return sMembers;
  }

  private async _redisGetPendingOrders(): Promise<string[]> {
    const [pendingDeposits, pendingSwaps, pendingWithdrawals, pendingBridgeToBinanceNetwork] = await Promise.all([
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_DEPOSIT),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_SWAP),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_WITHDRAWAL),
      this.redisCache.sMembers(this.REDIS_KEY_PENDING_BRIDGE_TO_BINANCE_NETWORK),
    ]);
    return [...pendingDeposits, ...pendingSwaps, ...pendingWithdrawals, ...pendingBridgeToBinanceNetwork];
  }
}
