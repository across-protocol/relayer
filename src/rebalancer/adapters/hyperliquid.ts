import { RedisCache } from "../../caching/RedisCache";
import { AugmentedTransaction } from "../../clients";
import {
  assert,
  BigNumber,
  blockExplorerLink,
  bnUint32Max,
  bnZero,
  CHAIN_IDs,
  Contract,
  ConvertDecimals,
  ERC20,
  ethers,
  EvmAddress,
  fromWei,
  getNetworkName,
  getProvider,
  getRedisCache,
  isWeekday,
  MAX_SAFE_ALLOWANCE,
  paginatedEventQuery,
  Signer,
  toBN,
  toBNWei,
  winston,
  forEachAsync,
  ZERO_ADDRESS,
  truncate,
  delay,
} from "../../utils";
import { RebalanceRoute } from "../rebalancer";
import * as hl from "@nktkas/hyperliquid";
import { BaseAdapter, OrderDetails } from "./baseAdapter";
import { RebalancerConfig } from "../RebalancerConfig";

enum STATUS {
  PENDING_BRIDGE_TO_HYPEREVM,
  PENDING_DEPOSIT_TO_HYPERCORE,
  PENDING_SWAP,
  PENDING_WITHDRAWAL_FROM_HYPERCORE,
}

interface SPOT_MARKET_META {
  index: number;
  name: string;
  symbol: string;
  quoteAssetIndex: number;
  baseAssetIndex: number;
  baseAssetName: string;
  quoteAssetName: string;
  minimumOrderSize: number;
  szDecimals: number;
  pxDecimals: number;
  isBuy: boolean;
}

interface TOKEN_META {
  evmSystemAddress: EvmAddress;
  tokenIndex: number;
  evmDecimals: number;
  coreDecimals: number;
  bridgeName: BRIDGE_NAME;
}

// HyperEVM address of CoreDepositWallet used to facilitates deposits and withdrawals with Hypercore.
const USDC_CORE_DEPOSIT_WALLET_ADDRESS = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24";

// Bridges we can use to bridge into and out of HyperEVM.
type BRIDGE_NAME = "OFT" | "CCTP";

// This adapter can be used to swap stables in Hyperliquid. This is preferable to swapping on source or destination
// prior to bridging because most chains have high fees for stablecoin swaps on DEX's, whereas bridging from OFT/CCTP
// into HyperEVM is free (or 0.01% for fast transfers) and then swapping on Hyperliquid is very cheap compared to DEX's.
// We should continually re-evaluate whether hyperliquid stablecoin swaps are indeed the cheapest option.
export class HyperliquidStablecoinSwapAdapter extends BaseAdapter {
  REDIS_PREFIX = "hyperliquid-stablecoin-swap:";
  // Key used to query latest cloid that uniquely identifies orders. Also used to set cloids when placing HL orders.
  REDIS_KEY_LATEST_NONCE = this.REDIS_PREFIX + "latest-nonce";
  // The following keys map to Sets of order nonces where the order has the relevant status.
  REDIS_KEY_PENDING_BRIDGE_TO_HYPEREVM = this.REDIS_PREFIX + "pending-bridge-to-hyperevm";
  REDIS_KEY_PENDING_DEPOSIT_TO_HYPERCORE = this.REDIS_PREFIX + "pending-deposit-to-hypercore";
  REDIS_KEY_PENDING_SWAP = this.REDIS_PREFIX + "pending-swap";
  REDIS_KEY_PENDING_WITHDRAWAL_FROM_HYPERCORE = this.REDIS_PREFIX + "pending-withdrawal-from-hypercore";

  // This table associates HL cloid's with rebalance route information, so we can correctly progress the pending order
  // through the EVM -> HL -> EVM lifecycle.
  REDIS_KEY_PENDING_ORDER = this.REDIS_PREFIX + "pending-order";

  // @dev Every market is saved in here twice, where the base and quote asset are reversed in the dictionary key
  // and the isBuy is flipped.
  private spotMarketMeta: { [name: string]: SPOT_MARKET_META } = {
    "USDT-USDC": {
      index: 166,
      name: "@166",
      symbol: "USDT/USDC",
      quoteAssetIndex: 268,
      baseAssetIndex: 0,
      quoteAssetName: "USDT",
      baseAssetName: "USDC",
      minimumOrderSize: 10,
      szDecimals: 2,
      pxDecimals: 5, // Max(5, 8 - szDecimals): https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
      isBuy: false,
    },
    "USDC-USDT": {
      index: 166,
      name: "@166",
      symbol: "USDT/USDC",
      quoteAssetIndex: 268,
      baseAssetIndex: 0,
      quoteAssetName: "USDT",
      baseAssetName: "USDC",
      minimumOrderSize: 10,
      szDecimals: 2,
      pxDecimals: 5, // Max(5, 8 - szDecimals): https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
      isBuy: true,
    },
  };

  private tokenMeta: { [symbol: string]: TOKEN_META } = {
    USDT: {
      evmSystemAddress: EvmAddress.from("0x200000000000000000000000000000000000010C"),
      tokenIndex: 268,
      evmDecimals: 6,
      coreDecimals: 8,
      bridgeName: "OFT",
    },
    USDC: {
      evmSystemAddress: EvmAddress.from("0x2000000000000000000000000000000000000000"),
      tokenIndex: 0,
      evmDecimals: 6,
      coreDecimals: 8,
      bridgeName: "CCTP",
    },
  };

  private maxSlippagePct = 0.02; // @todo make this configurable

  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {
    super(logger, config, baseSigner);
  }

  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    await super.initialize(_availableRoutes);

    const { HYPEREVM } = CHAIN_IDs;
    const provider_999 = await getProvider(HYPEREVM);
    const connectedSigner_999 = this.baseSigner.connect(provider_999);
    this.redisCache = (await getRedisCache(this.logger)) as RedisCache;

    for (const route of this.availableRoutes) {
      // Initialize a provider for the source chain and check if we have spot market data
      // and token data for that source token and destination token.
      const expectedName = `${route.sourceToken}-${route.destinationToken}`;
      if (!this.spotMarketMeta[expectedName]) {
        throw new Error(`Missing spotMarketMeta data for ${expectedName}`);
      }
    }

    this.allDestinationChains = new Set<number>(this.availableRoutes.map((x) => x.destinationChain));
    this.allSourceChains = new Set<number>(this.availableRoutes.map((x) => x.sourceChain));

    // Tasks:
    // - Check allowances and set them as needed.
    // this.hyperliquidHelper = new Contract(
    //     "todo",
    //     [],
    //     this.baseSigner
    // );

    // Check allowance for CoreDepositWallet required to deposit USDC to Hypercore.
    const usdc = new Contract(this._getTokenInfo("USDC", HYPEREVM).address.toNative(), ERC20.abi, connectedSigner_999);
    const allowance = await usdc.allowance(this.baseSignerAddress.toNative(), USDC_CORE_DEPOSIT_WALLET_ADDRESS);
    if (allowance.lt(toBN(MAX_SAFE_ALLOWANCE).div(2))) {
      this.multicallerClient.enqueueTransaction({
        contract: usdc,
        chainId: HYPEREVM,
        method: "approve",
        nonMulticall: true,
        unpermissioned: false,
        args: [USDC_CORE_DEPOSIT_WALLET_ADDRESS, MAX_SAFE_ALLOWANCE],
        message: "Approved USDC for CoreDepositWallet",
        mrkdwn: "Approved USDC for CoreDepositWallet",
      });
    }
    await this.multicallerClient.executeTxnQueues();
  }

  async initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void> {
    this._assertInitialized();

    const spotMarketMeta = this._getSpotMarketMetaForRoute(rebalanceRoute.sourceToken, rebalanceRoute.destinationToken);
    const sourceTokenInfo = this._getTokenMeta(rebalanceRoute.sourceToken);
    assert(
      amountToTransfer.gte(toBNWei(spotMarketMeta.minimumOrderSize, sourceTokenInfo.evmDecimals)),
      `Max amount to transfer ${amountToTransfer.toString()} is less than minimum order size ${toBNWei(
        spotMarketMeta.minimumOrderSize,
        sourceTokenInfo.evmDecimals
      ).toString()}`
    );

    // TODO: The amount we transfer in here might not be fully placed into an order dependning on the market's
    // minimum tick size (i.e. szDecimals and pxDecimals), so we might be left with some dust in the account.
    // We should figure out how to only transfer in exactly how many tokens we intend to set the sz to.

    const cloid = await this._redisGetNextCloid();

    const { sourceToken, sourceChain, destinationChain, destinationToken } = rebalanceRoute;

    // When initializing a rebalance, the order status should be set either to PENDING_BRIDGE_TO_HYPEREVM or PENDING_DEPOSIT_TO_HYPERCORE
    // depending on the source chain.
    if (rebalanceRoute.sourceChain !== CHAIN_IDs.HYPEREVM) {
      // Bridge this token into HyperEVM first
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.initializeRebalance",
        message: `Creating new order ${cloid} by first bridging ${sourceToken} into HyperEVM from ${getNetworkName(
          sourceChain
        )}`,
        destinationToken,
        destinationChain: getNetworkName(destinationChain),
        amountToTransfer: amountToTransfer.toString(),
      });

      const amountReceivedFromBridge = await this._bridgeToChain(
        rebalanceRoute.sourceToken,
        rebalanceRoute.sourceChain,
        CHAIN_IDs.HYPEREVM,
        amountToTransfer
      );

      await this._redisCreateOrder(cloid, STATUS.PENDING_BRIDGE_TO_HYPEREVM, rebalanceRoute, amountReceivedFromBridge);
    } else {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.initializeRebalance",
        message: `Creating new order ${cloid} by depositing ${sourceToken} from HyperEVM to HyperCore`,
        destinationToken,
        destinationChain: getNetworkName(destinationChain),
        amountToTransfer: amountToTransfer.toString(),
      });

      await this._depositToHypercore(rebalanceRoute.sourceToken, amountToTransfer);
      await this._redisCreateOrder(cloid, STATUS.PENDING_DEPOSIT_TO_HYPERCORE, rebalanceRoute, amountToTransfer);
    }
  }

  async _getUserTakerFeePct(skipCache = false): Promise<BigNumber> {
    const cacheKey = "hyperliquid-user-fees";

    if (!skipCache) {
      const cached = await this.redisCache.get<string>(cacheKey);
      if (cached) {
        return BigNumber.from(cached);
      }
    }
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const userFees = await infoClient.userFees({ user: this.baseSignerAddress.toNative() });
    const takerBaseFee = Number(userFees.userSpotCrossRate);
    const takerFee = takerBaseFee * 0.2; // for stable pairs, fee is 20% of the taker base fee
    const takerFeePct = toBNWei(takerFee.toFixed(18), 18).mul(100);

    // Reset cache if we've fetched a new API response.
    await this.redisCache.set(cacheKey, takerFeePct.toString()); // Use default TTL which is a long time as
    // this response is not expected to change frequently.
    return takerFeePct;
  }

  async getEstimatedCost(
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    debugLog: boolean
  ): Promise<BigNumber> {
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const { slippagePct, px } = await this._getLatestPrice(sourceToken, destinationToken, amountToTransfer);
    const latestPrice = Number(px);
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

    const takerFeePct = await this._getUserTakerFeePct();
    const takerFeeFixed = takerFeePct.mul(amountToTransfer).div(toBNWei(100, 18));

    // Bridge to HyperEVM Fee:
    let bridgeToHyperEvmFee = bnZero;
    if (rebalanceRoute.sourceChain !== CHAIN_IDs.HYPEREVM) {
      bridgeToHyperEvmFee = await this._getBridgeFeePct(sourceChain, CHAIN_IDs.HYPEREVM, sourceToken, amountToTransfer);
    }

    // Bridge from HyperEVMFee:
    let bridgeFromHyperEvmFee = bnZero;
    if (rebalanceRoute.destinationChain !== CHAIN_IDs.HYPEREVM) {
      bridgeFromHyperEvmFee = await this._getBridgeFeePct(
        CHAIN_IDs.HYPEREVM,
        destinationChain,
        destinationToken,
        amountToTransfer
      );
    }

    // - Opportunity cost of capital when withdrawing from 999. The rudimentary logic here is to assume 4bps when the
    // OFT rebalance would end on a weekday.
    //  @todo a better way to do this might be to use historical fills to calculate the relayer's
    // latest profitability % to forecast the opportunity cost of capital.
    const oftRebalanceEndTime =
      new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).getTime() + 11 * 60 * 60 * 1000;
    const opportunityCostOfCapitalBps =
      destinationToken === "USDT" &&
      destinationChain !== CHAIN_IDs.HYPEREVM &&
      (isWeekday() || isWeekday(new Date(oftRebalanceEndTime)))
        ? 4
        : 0;
    const opportunityCostOfCapitalFixed = toBNWei(opportunityCostOfCapitalBps, 18)
      .mul(amountToTransfer)
      .div(toBNWei(10000, 18));

    const totalFee = spreadFee
      .add(slippage)
      .add(takerFeeFixed)
      .add(bridgeToHyperEvmFee)
      .add(bridgeFromHyperEvmFee)
      .add(opportunityCostOfCapitalFixed);

    if (debugLog) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.getEstimatedCost",
        message: `Calculating total fees for rebalance route ${sourceToken} on ${getNetworkName(
          sourceChain
        )} to ${destinationToken} on ${getNetworkName(
          destinationChain
        )} with amount to transfer ${amountToTransfer.toString()}`,
        slippagePct,
        slippage: slippage.toString(),
        estimatedTakerPrice: latestPrice,
        spreadPct: spreadPct * 100,
        spreadFee: spreadFee.toString(),
        takerFeePct: fromWei(takerFeePct, 18),
        takerFee: takerFeeFixed.toString(),
        takerFeeFixed: takerFeeFixed.toString(),
        bridgeToHyperEvmFee: bridgeToHyperEvmFee.toString(),
        bridgeFromHyperEvmFee: bridgeFromHyperEvmFee.toString(),
        opportunityCostOfCapitalFixed: opportunityCostOfCapitalFixed.toString(),
        totalFee: totalFee.toString(),
      });
    }

    return totalFee;
  }

  private async _createHlOrder(orderDetails: OrderDetails, cloid: string): Promise<void> {
    const { sourceToken, amountToTransfer } = orderDetails;
    const tokenMeta = this._getTokenMeta(sourceToken);

    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });

    const spotClearingHouseState = await infoClient.spotClearinghouseState({ user: this.baseSignerAddress.toNative() });

    const balanceInputToken = spotClearingHouseState.balances.find(
      (balance) => balance.coin === this._remapTokenSymbolToHlSymbol(sourceToken)
    );
    if (!balanceInputToken) {
      throw new Error(`No balance found in spotClearingHouseState for input token: ${sourceToken}`);
    }

    const availableBalance = toBNWei(balanceInputToken.total, tokenMeta.coreDecimals).sub(
      toBNWei(balanceInputToken.hold, tokenMeta.coreDecimals)
    );
    const availableBalanceEvmDecimals = ConvertDecimals(
      tokenMeta.coreDecimals,
      tokenMeta.evmDecimals
    )(availableBalance);
    if (availableBalanceEvmDecimals.lt(amountToTransfer)) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter._createHlOrder",
        message: `Available balance for input token: ${sourceToken} (${availableBalanceEvmDecimals.toString()}) is less than amount to transfer: ${amountToTransfer.toString()}`,
        availableBalanceEvmDecimals: availableBalanceEvmDecimals.toString(),
        amountToTransfer: amountToTransfer.toString(),
      });
    }

    // Check for open orders and available balance. If no open orders matching desired CLOID and available balance
    // is sufficient, then place order.

    await this._placeMarketOrder(orderDetails, cloid, this.maxSlippagePct);
  }

  // TODO: Pass in from and to timestamps here to make sure updates across all chains are in sync.
  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();
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

    // Figure out what time we last received an update so we can get all updates since then:
    // @todo Replace this hard code lookback
    const lastPollEnd = this._getFromTimestamp();

    const pendingBridgeToHyperevm = await this._redisGetPendingBridgeToHyperevm();
    if (pendingBridgeToHyperevm.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending bridge to HyperEVM",
        pendingBridgeToHyperevm,
      });
    }
    for (const cloid of pendingBridgeToHyperevm) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { sourceToken, amountToTransfer, sourceChain } = orderDetails;
      // Check if we have enough balance on HyperEVM to progress the order status:
      const hyperevmBalance = await this._getERC20Balance(
        CHAIN_IDs.HYPEREVM,
        this._getTokenInfo(sourceToken, sourceChain).address.toNative()
      );
      const amountConverter = this._getAmountConverter(
        orderDetails.sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address,
        CHAIN_IDs.HYPEREVM,
        this._getTokenInfo(sourceToken, CHAIN_IDs.HYPEREVM).address
      );
      const requiredAmountOnHyperevm = amountConverter(amountToTransfer);
      if (hyperevmBalance.lt(requiredAmountOnHyperevm)) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Not enough ${sourceToken} balance on HyperEVM to progress the order ${cloid} with status PENDING_BRIDGE_TO_HYPEREVM`,
          hyperevmBalance: hyperevmBalance.toString(),
          requiredAmountOnHyperevm: requiredAmountOnHyperevm.toString(),
        });
      } else {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `We have enough ${sourceToken} balance on HyperEVM to bridge into Hypercore, initiating a deposit now for ${requiredAmountOnHyperevm.toString()} for order ${cloid}`,
          hyperevmBalance: hyperevmBalance.toString(),
          requiredAmountOnHyperevm: requiredAmountOnHyperevm.toString(),
        });
        await this._depositToHypercore(sourceToken, requiredAmountOnHyperevm);
        await this._redisUpdateOrderStatus(
          cloid,
          STATUS.PENDING_BRIDGE_TO_HYPEREVM,
          STATUS.PENDING_DEPOSIT_TO_HYPERCORE
        );
      }
    }

    const pendingBridgeToHypercore = await this._redisGetPendingDepositsToHypercore();
    if (pendingBridgeToHypercore.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending deposit to Hypercore",
        pendingBridgeToHypercore,
      });
    }
    for (const cloid of pendingBridgeToHypercore) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      await this._createHlOrder(orderDetails, cloid);
      await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_DEPOSIT_TO_HYPERCORE, STATUS.PENDING_SWAP);
      // Wait some time after placing a new order to allow for it to execute and hopefully be immediately filled
      // and reflected in our HL balance. Then in the next step we can withdraw it from Hypercore.
      await delay(10);
    }

    let openOrders: hl.OpenOrdersResponse = [];
    // Check pending swap statuses before checking pending deposits to hypercore otherwise we might place an order,
    // and attempt to replace it because it wasn't immediately executed.
    const pendingSwaps = await this._redisGetPendingSwaps();
    if (pendingSwaps.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending swap",
        pendingSwaps,
      });
      const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
      openOrders = await infoClient.openOrders({ user: this.baseSignerAddress.toNative() });
      if (openOrders.length > 0) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: "Open orders",
          openOrders,
        });
      }
    }
    for (const cloid of pendingSwaps) {
      const matchingFill = await this._getMatchingFillForCloid(cloid, lastPollEnd * 1000);
      const matchingOpenOrder = openOrders.find((order) => order.cloid === cloid);
      if (matchingFill) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Open order for cloid ${cloid} filled with size ${matchingFill.amountToWithdraw.toString()}! Proceeding to withdraw from Hypercore.`,
        });

        // Issue a withdrawal from HL now:
        const existingOrder = await this._redisGetOrderDetails(cloid);
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Withdrawing ${matchingFill.amountToWithdraw.toString()} ${
            existingOrder.destinationToken
          } from Hypercore to HyperEVM.`,
        });
        await this._withdrawToHyperevm(existingOrder.destinationToken, matchingFill.amountToWithdraw);
        await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_SWAP, STATUS.PENDING_WITHDRAWAL_FROM_HYPERCORE);
      } else if (!matchingOpenOrder) {
        const existingOrder = await this._redisGetOrderDetails(cloid);
        await this._createHlOrder(existingOrder, cloid);
      } else {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: "Order is still unfilled",
          matchingOpenOrder,
        });
      }
    }

    const pendingWithdrawals = await this._redisGetPendingWithdrawals();
    if (pendingWithdrawals.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending withdrawal from Hypercore",
        pendingWithdrawals,
      });
    }
    const unfinalizedWithdrawalAmounts: { [destinationToken: string]: BigNumber } = {};
    for (const cloid of pendingWithdrawals) {
      // For each finalized withdrawal from Hypercore, delete its status from Redis and optionally initiate
      // a bridge to the final destination chain if necessary.
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const matchingFill = await this._getMatchingFillForCloid(cloid, this._getFromTimestamp() * 1000);
      if (!matchingFill) {
        throw new Error(`No matching fill found for cloid ${cloid} that has status PENDING_WITHDRAWAL_FROM_HYPERCORE`);
      }

      // Only proceed to update the order status if it has finalized:
      const initiatedWithdrawals = await this._getInitiatedWithdrawalsFromHypercore(
        orderDetails.destinationToken,
        matchingFill.details.time
      );
      if (initiatedWithdrawals.length === 0) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Cannot find any initiated withdrawals that could correspond to cloid ${cloid} which filled at ${matchingFill.details.time}, waiting`,
        });
        continue;
      }
      const destinationTokenMeta = this._getTokenMeta(orderDetails.destinationToken);
      const expectedAmountToReceive = ConvertDecimals(
        destinationTokenMeta.coreDecimals,
        destinationTokenMeta.evmDecimals
      )(matchingFill.amountToWithdraw);
      const unfinalizedWithdrawalAmount =
        unfinalizedWithdrawalAmounts[orderDetails.destinationToken] ??
        (await this._getUnfinalizedWithdrawalAmountFromHypercore(
          orderDetails.destinationToken,
          matchingFill.details.time
        ));
      // If HL were to impose a withdraw fee then we'd need to subtract the estimated fee from the expectedAmountToReceive
      // here otherwise we might have received less than the expected amount on HyperEVM.
      if (unfinalizedWithdrawalAmount.gte(expectedAmountToReceive)) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Guessing order ${cloid} has not finalized yet because the unfinalized amount ${unfinalizedWithdrawalAmount.toString()} is >= than the expected withdrawal amount ${expectedAmountToReceive.toString()}`,
        });
        unfinalizedWithdrawalAmounts[orderDetails.destinationToken] =
          unfinalizedWithdrawalAmount.sub(expectedAmountToReceive);
        continue;
      }

      if (orderDetails.destinationChain === CHAIN_IDs.HYPEREVM) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Deleting order details from Redis with cloid ${cloid} because it has completed!`,
        });
      } else {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Sending order with cloid ${cloid} from HyperEVM to final destination chain ${orderDetails.destinationChain}, and deleting order details from Redis!`,
          expectedAmountToReceive: expectedAmountToReceive.toString(),
        });
        await this._bridgeToChain(
          orderDetails.destinationToken,
          CHAIN_IDs.HYPEREVM,
          orderDetails.destinationChain,
          expectedAmountToReceive
        );
      }
      // We no longer need this order information, so we can delete it:
      await this._redisDeleteOrder(cloid, STATUS.PENDING_WITHDRAWAL_FROM_HYPERCORE);
    }
  }

  async _getLatestPrice(
    sourceToken: string,
    destinationToken: string,
    amountToTransfer: BigNumber
  ): Promise<{ px: string; slippagePct: number }> {
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const l2Book = await infoClient.l2Book({ coin: spotMarketMeta.name });
    const bids = l2Book.levels[0];
    const asks = l2Book.levels[1];

    const tokenMeta = this._getTokenMeta(destinationToken);
    const sideOfBookToTraverse = spotMarketMeta.isBuy ? asks : bids;
    const bestPx = Number(sideOfBookToTraverse[0].px);
    let szFilledSoFar = bnZero;
    const maxPxReached = sideOfBookToTraverse.find((level) => {
      // Note: sz is always denominated in the base asset, so if we are buying, then the amountToTransfer (i.e.
      // the amount that we want to buy of the base asset) is denominated in the quote asset and we need to convert it
      // into the base asset.
      const sz = spotMarketMeta.isBuy ? Number(level.sz) * Number(level.px) : Number(level.sz);
      const szWei = toBNWei(truncate(sz, tokenMeta.evmDecimals));
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
    const slippagePct = Math.abs(((Number(maxPxReached.px) - bestPx) / bestPx) * 100);
    return {
      px: maxPxReached.px,
      slippagePct,
    };
  }

  async _placeMarketOrder(orderDetails: OrderDetails, cloid: string, maxSlippagePct: number): Promise<void> {
    const { sourceToken, destinationToken, amountToTransfer } = orderDetails;
    const { px, slippagePct } = await this._getLatestPrice(sourceToken, destinationToken, amountToTransfer);
    if (slippagePct > maxSlippagePct) {
      throw new Error(`Slippage of ${slippagePct}% is greater than the max slippage of ${maxSlippagePct}%`);
    }
    await this._placeLimitOrder(orderDetails, cloid, px);
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
    const spotMarketMeta = this._getSpotMarketMetaForRoute(existingOrder.sourceToken, existingOrder.destinationToken);

    // If fill was a buy, then received amount is denominated in base asset, same as sz.
    // If fill was a sell, then received amount is denominated in quote asset, so receivedAmount = px * sz.
    let amountToWithdraw: BigNumber;
    if (matchingFill.dir === "Buy") {
      amountToWithdraw = toBNWei(matchingFill.sz, destinationTokenMeta.coreDecimals);
    } else {
      amountToWithdraw = toBNWei(matchingFill.sz, destinationTokenMeta.coreDecimals)
        .mul(toBNWei(matchingFill.px, spotMarketMeta.pxDecimals))
        .div(10 ** spotMarketMeta.pxDecimals);
    }

    // We need to make sure there are not more than evmDecimals decimals for the amount to withdraw or the HL
    // spotSend/sendAsset transaction will fail "Invalid number of decimals".
    amountToWithdraw = toBNWei(
      Number(fromWei(amountToWithdraw, destinationTokenMeta.coreDecimals)).toFixed(destinationTokenMeta.evmDecimals),
      destinationTokenMeta.coreDecimals
    );
    return { details: matchingFill, amountToWithdraw };
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

  private _getSzForOrder(
    sourceToken: string,
    destinationToken: string,
    amountToTransfer: BigNumber,
    px: string
  ): number {
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);

    // Determining sz:
    // - The rebalanceRoute.amount is the amount of source tokens that are depositing into HL. It should already be
    // adjusted upwards to pay for any expected fees. However, sz is always specified in the base asset and px is
    // base / quote asset (px * sz returns a value denominated in the quote asset).
    // - Therefore, if isBuy is "true" then we are buying the "sz" amount of base asset with "rebalanceRoute.amount"
    // of the quote asset. We need to solve for "sz" and rebalance.amount = sz * px.
    // - If isBuy is "false" then we are selling "sz" amount of base asset to obtain the quote asset. The rebalanceRoute.amount
    // is denominated in the base asset, so rebalance.amount can be simply set to sz.
    const sz = spotMarketMeta.isBuy
      ? amountToTransfer.mul(10 ** spotMarketMeta.pxDecimals).div(toBNWei(px, spotMarketMeta.pxDecimals))
      : amountToTransfer;
    const destinationTokenMeta = this._getTokenMeta(destinationToken);
    const sourceTokenMeta = this._getTokenMeta(sourceToken);
    const evmDecimals = spotMarketMeta.isBuy ? destinationTokenMeta.evmDecimals : sourceTokenMeta.evmDecimals;
    const szNumber = Number(fromWei(sz, evmDecimals));
    const szFormatted = truncate(szNumber, spotMarketMeta.szDecimals);
    assert(szFormatted >= spotMarketMeta.minimumOrderSize, "Max amount to transfer is less than minimum order size");
    return szFormatted;
  }

  private async _placeLimitOrder(orderDetails: OrderDetails, cloid: string, px: string): Promise<void> {
    const { sourceToken, destinationToken, amountToTransfer } = orderDetails;
    this.logger.debug({
      at: "HyperliquidStablecoinSwapAdapter._placeLimitOrder",
      message: `Placing new order for cloid: ${cloid} with px: ${px}`,
      sourceToken,
      destinationToken,
      amountToTransfer: amountToTransfer.toString(),
    });

    // Place order:
    const exchangeClient = new hl.ExchangeClient({
      transport: new hl.HttpTransport(),
      wallet: ethers.Wallet.fromMnemonic(process.env.MNEMONIC),
    });
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);

    // Determining sz:
    // - The rebalanceRoute.amount is the amount of source tokens that are depositing into HL. It should already be
    // adjusted upwards to pay for any expected fees. However, sz is always specified in the base asset and px is
    // base / quote asset (px * sz returns a value denominated in the quote asset).
    // - Therefore, if isBuy is "true" then we are buying the "sz" amount of base asset with "rebalanceRoute.amount"
    // of the quote asset. We need to solve for "sz" and rebalance.amount = sz * px.
    // - If isBuy is "false" then we are selling "sz" amount of base asset to obtain the quote asset. The rebalanceRoute.amount
    // is denominated in the base asset, so rebalance.amount can be simply set to sz.
    const sz = this._getSzForOrder(sourceToken, destinationToken, amountToTransfer, px);
    // sz is always in base units, so if we're buying the base unit then
    try {
      const orderDetails = {
        a: 10000 + spotMarketMeta.index, // Asset index + spot asset index prefix
        b: spotMarketMeta.isBuy, // Buy side (if true, buys quote asset else sells quote asset for base asset)
        p: px, // Price
        s: sz, // Size
        r: false, // Reduce only
        t: { limit: { tif: "Gtc" as const } },
        c: cloid,
      };
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter._placeLimitOrder",
        message: `Submitting order ${cloid} to Hyperliquid`,
        orderDetails,
      });
      const result = await exchangeClient.order({
        orders: [orderDetails],
        grouping: "na",
      });
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter._placeLimitOrder",
        message: `Order result for order ${cloid}`,
        result,
      });
    } catch (error: unknown) {
      if (error instanceof hl.ApiRequestError) {
        this.logger.error({
          at: "HyperliquidStablecoinSwapAdapter._placeLimitOrder",
          message: `API request error with status ${JSON.stringify(error.response)}`,
          error: error.toString(),
        });
      } else if (error instanceof hl.TransportError) {
        this.logger.error({
          at: "HyperliquidStablecoinSwapAdapter._placeLimitOrder",
          message: "Transport error",
          error: error.toString(),
        });
      } else {
        this.logger.error({
          at: "HyperliquidStablecoinSwapAdapter._placeLimitOrder",
          message: "Unknown error",
          error: error.toString(),
        });
      }
    }
  }

  private async _withdrawToHyperevm(destinationToken: string, amountToWithdrawCorePrecision: BigNumber): Promise<void> {
    const { HYPEREVM } = CHAIN_IDs;
    // CoreWriter contract on EVM that can be used to interact with Hypercore.
    const CORE_WRITER_EVM_ADDRESS = "0x3333333333333333333333333333333333333333";
    // CoreWriter exposes a single function that charges 20k gas to send an instruction on Hypercore.
    const CORE_WRITER_ABI = ["function sendRawAction(bytes)"];
    // To transfer Core balance for any token besides USDC, a 'spotSend' action must be specified in the payload to sendRawAction:
    // To transfer USDC from Core to EVM we need to use the 'sendAsset' action.
    const PREFIX_BYTES = ethers.utils.hexlify([
      1, // byte 0: version, must be 1
      // bytes 1-3: unique action index as described here:
      // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore#corewriter-contract
      0,
      0,
      destinationToken === "USDC" ? 13 : 6, // action index of spotSend is 6 and sendAsset is 13
    ]);
    const tokenMeta = this._getTokenMeta(destinationToken);
    const provider = await getProvider(HYPEREVM);
    const connectedSigner = this.baseSigner.connect(provider);

    const coreWriterContract = new Contract(CORE_WRITER_EVM_ADDRESS, CORE_WRITER_ABI, connectedSigner);
    const argBytes =
      destinationToken === "USDC"
        ? ethers.utils.defaultAbiCoder.encode(
            ["address", "address", "uint32", "uint32", "uint64", "uint64"],
            [
              // @dev to withdraw USDC, essentially transfer spot USDC to the USDC system account:
              tokenMeta.evmSystemAddress.toNative(),
              ZERO_ADDRESS, // subAccount
              bnUint32Max, // type(uint32).max for spot
              bnUint32Max, // type(uint32).max for spot
              tokenMeta.tokenIndex,
              amountToWithdrawCorePrecision,
            ]
          )
        : ethers.utils.defaultAbiCoder.encode(
            ["address", "uint64", "uint64"],
            [tokenMeta.evmSystemAddress.toNative(), tokenMeta.tokenIndex, amountToWithdrawCorePrecision]
          );

    // @dev costs 20k gas on HyperEVM
    const bytes = ethers.utils.hexlify(ethers.utils.concat([PREFIX_BYTES, argBytes]));

    const amountToWithdraw = fromWei(amountToWithdrawCorePrecision, tokenMeta.coreDecimals);
    this.logger.debug({
      at: "HyperliquidStablecoinSwapAdapter._withdrawToHyperevm",
      message: `Withdrawing ${amountToWithdraw} ${destinationToken} from Core to Evm by calling CoreWriter.sendRawAction() with bytes: ${bytes}`,
    });

    // Note: I'd like this to work via the multicaller client or runTransaction but the .wait() seems to fail.
    // Note: If sending multicaller client txn, unpermissioned:false and nonMulticall:true must be set.
    const txn = await coreWriterContract.sendRawAction(bytes);
    this.logger.debug({
      at: "HyperliquidStablecoinSwapAdapter._withdrawToHyperevm",
      message: `Withdrew ${amountToWithdraw} ${destinationToken} from Hypercore to HyperEVM`,
      txn: blockExplorerLink(txn.hash, HYPEREVM),
    });
  }

  private async _depositToHypercore(sourceToken: string, amountToDepositEvmPrecision: BigNumber): Promise<void> {
    const { HYPEREVM } = CHAIN_IDs;
    const hyperevmToken = this._getTokenInfo(sourceToken, HYPEREVM).address.toNative();
    const provider = await getProvider(HYPEREVM);
    const connectedSigner = this.baseSigner.connect(provider);
    const erc20 = new Contract(hyperevmToken, ERC20.abi, connectedSigner);
    const amountReadable = fromWei(amountToDepositEvmPrecision, this._getTokenInfo(sourceToken, HYPEREVM).decimals);
    let transaction: AugmentedTransaction;
    if (sourceToken === "USDC") {
      const coreDepositWallet = new ethers.Contract(
        USDC_CORE_DEPOSIT_WALLET_ADDRESS,
        ["function deposit(uint256 amount, uint32 destinationDex)"],
        connectedSigner
      );
      transaction = {
        contract: coreDepositWallet,
        chainId: HYPEREVM,
        method: "deposit",
        unpermissioned: false,
        nonMulticall: true,
        args: [
          amountToDepositEvmPrecision,
          bnUint32Max, // type(uint32).max, used to deposit into spot account
        ],
        message: `Deposited USDC into Hypercore via CoreDepositWallet from ${getNetworkName(HYPEREVM)}`,
        mrkdwn: `Deposited ${amountReadable} USDC into Hypercore via CoreDepositWallet from ${getNetworkName(
          HYPEREVM
        )}`,
      };
    } else {
      const tokenMeta = this._getTokenMeta(sourceToken);
      transaction = {
        contract: erc20,
        chainId: HYPEREVM,
        method: "transfer",
        unpermissioned: false,
        nonMulticall: true,
        args: [tokenMeta.evmSystemAddress.toNative(), amountToDepositEvmPrecision],
        message: `Deposited ${sourceToken} into Hypercore from ${getNetworkName(HYPEREVM)}`,
        mrkdwn: `Deposited ${amountReadable} ${sourceToken} into Hypercore from ${getNetworkName(HYPEREVM)}`,
      };
    }
    await this._submitTransaction(transaction);
  }

  private async _getInitiatedWithdrawalsFromHypercore(
    destinationToken: string,
    withdrawalInitiatedEarliestTimestamp: number
  ): Promise<any[]> {
    const tokenMeta = this._getTokenMeta(destinationToken);
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const initiatedWithdrawals = (
      await infoClient.userNonFundingLedgerUpdates({
        user: this.baseSignerAddress.toNative(),
        startTime: withdrawalInitiatedEarliestTimestamp,
      })
    ).filter((_update) => {
      if ((_update.delta.type as any) === "send") {
        const update = _update as { delta: { token: string; destination: string; user: string } };
        return (
          update.delta.token === this._remapTokenSymbolToHlSymbol(destinationToken) &&
          update.delta.destination.toLowerCase() === tokenMeta.evmSystemAddress.toNative().toLowerCase() &&
          update.delta.user.toLowerCase() === this.baseSignerAddress.toNative().toLowerCase()
        );
      } else {
        const update = _update;
        return (
          update.delta.type === "spotTransfer" &&
          update.delta.token === this._remapTokenSymbolToHlSymbol(destinationToken) &&
          update.delta.destination.toLowerCase() === tokenMeta.evmSystemAddress.toNative().toLowerCase() &&
          update.delta.user.toLowerCase() === this.baseSignerAddress.toNative().toLowerCase()
        );
      }
      // @dev send type isn't correctly included in the SDK
    });
    return initiatedWithdrawals;
  }

  private async _getUnfinalizedWithdrawalAmountFromHypercore(
    destinationToken: string,
    withdrawalInitiatedEarliestTimestamp: number
  ): Promise<BigNumber> {
    const { HYPEREVM } = CHAIN_IDs;
    const provider = await getProvider(HYPEREVM);
    const eventSearchConfig = await this._getEventSearchConfig(HYPEREVM);
    const hyperevmToken = new Contract(
      this._getTokenInfo(destinationToken, HYPEREVM).address.toNative(),
      ERC20.abi,
      this.baseSigner.connect(provider)
    );
    const tokenMeta = this._getTokenMeta(destinationToken);
    const finalizedWithdrawals = await paginatedEventQuery(
      hyperevmToken,
      hyperevmToken.filters.Transfer(
        destinationToken === "USDC" ? USDC_CORE_DEPOSIT_WALLET_ADDRESS : tokenMeta.evmSystemAddress.toNative(),
        this.baseSignerAddress.toNative()
      ),
      eventSearchConfig
    );
    const initiatedWithdrawals = await this._getInitiatedWithdrawalsFromHypercore(
      destinationToken,
      withdrawalInitiatedEarliestTimestamp
    );

    let unfinalizedWithdrawalAmount = bnZero;
    const finalizedWithdrawalTxnHashes = new Set<string>();
    for (const initiated of initiatedWithdrawals) {
      const withdrawalAmount = toBNWei(initiated.delta.amount, tokenMeta.evmDecimals);
      assert(
        initiated.delta.type === "spotTransfer" || initiated.delta.type === "send",
        "Expected spotTransfer or send"
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

  private _assertInitialized(): void {
    assert(this.initialized, "HyperliquidStablecoinSwapAdapter not initialized");
  }

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();
    const { HYPEREVM } = CHAIN_IDs;
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    // This function returns the total virtual balance of token that is in flight to chain.

    // If there are any unfinalized bridges on the way to the destination chain, add virtual balances for them.
    await forEachAsync(Array.from(this.allDestinationChains), async (destinationChain) => {
      pendingRebalances[destinationChain] ??= {};
      if (destinationChain !== HYPEREVM) {
        const [usdtPendingRebalanceAmount, usdcPendingRebalanceAmount] = await Promise.all([
          this._getUnfinalizedOftBridgeAmount(HYPEREVM, destinationChain),
          this._getUnfinalizedCctpBridgeAmount(HYPEREVM, destinationChain),
        ]);
        if (usdtPendingRebalanceAmount.gt(bnZero)) {
          this.logger.debug({
            at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
            message: `Adding ${usdtPendingRebalanceAmount.toString()} for pending OFT rebalances from HyperEVM to ${destinationChain}`,
          });
          pendingRebalances[destinationChain]["USDT"] ??= usdtPendingRebalanceAmount;
        }
        if (usdcPendingRebalanceAmount.gt(bnZero)) {
          this.logger.debug({
            at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
            message: `Adding ${usdcPendingRebalanceAmount.toString()} for pending CCTP rebalances from HyperEVM to ${destinationChain}`,
          });
          pendingRebalances[destinationChain]["USDC"] ??= usdcPendingRebalanceAmount;
        }
      }
    });

    pendingRebalances[HYPEREVM] ??= {};
    const pendingBridgeToHyperevm = await this._redisGetPendingBridgeToHyperevm();
    if (pendingBridgeToHyperevm.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
        message: `Pending bridge to Hyperevm cloids: ${pendingBridgeToHyperevm.join(", ")}`,
      });
    }

    // If there are any finalized bridges to HyperEVM that correspond to orders that should subsequently be deposited
    // into Hypercore, we should subtract their virtual balance from HyperEVM.
    await forEachAsync(Array.from(this.allSourceChains), async (sourceChain) => {
      pendingRebalances[sourceChain] ??= {};
      if (sourceChain !== HYPEREVM) {
        let [usdtPendingRebalanceAmount, usdcPendingRebalanceAmount] = await Promise.all([
          this._getUnfinalizedOftBridgeAmount(sourceChain, HYPEREVM),
          this._getUnfinalizedCctpBridgeAmount(sourceChain, HYPEREVM),
        ]);
        for (const cloid of pendingBridgeToHyperevm) {
          const orderDetails = await this._redisGetOrderDetails(cloid);
          const { sourceToken, destinationToken, amountToTransfer } = orderDetails;
          if (orderDetails.sourceChain !== sourceChain) {
            continue;
          }

          const amountConverter = this._getAmountConverter(
            sourceChain,
            this._getTokenInfo(sourceToken, sourceChain).address,
            HYPEREVM,
            this._getTokenInfo(sourceToken, HYPEREVM).address
          );

          // Check if this order is pending, if it is, then do nothing, but if it has finalized, then we need to subtract
          // its balance from HyperEVM. We are assuming that the unfinalizedBridgeAmountToHyperevm is perfectly explained
          // by orders with status PENDING_BRIDGE_TO_HYPEREVM.
          const convertedOrderAmount = amountConverter(amountToTransfer);
          const unfinalizedBridgeAmountToHyperevm =
            destinationToken === "USDT" ? usdtPendingRebalanceAmount : usdcPendingRebalanceAmount;

          // The algorithm here is a bit subtle. We can't easily associate pending OFT/CCTP rebalances with order cloids,
          // unless we saved the transaction hash down at the time of creating the cloid and initiating the bridge to
          // hyperevm. (If we did do that, then we'd need to keep track of pending rebalances and we'd have to
          // update them in the event queries above). The alternative implementation we use is to track the total
          // pending unfinalized amount, and subtract any order expected amounts from the pending amount. We can then
          // back into how many of these pending bridges to HyperEVM have finalized.
          if (unfinalizedBridgeAmountToHyperevm.gte(convertedOrderAmount)) {
            this.logger.debug({
              at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
              message: `Order cloid ${cloid} is possibly pending finalization to Hyperevm still (remaining pending amount: ${unfinalizedBridgeAmountToHyperevm.toString()}, order expected amount: ${convertedOrderAmount.toString()})`,
            });

            if (destinationToken === "USDT") {
              usdtPendingRebalanceAmount = usdtPendingRebalanceAmount.sub(convertedOrderAmount);
            } else {
              usdcPendingRebalanceAmount = usdcPendingRebalanceAmount.sub(convertedOrderAmount);
            }
            continue;
          }

          // Order has finalized, subtract virtual balance from HyperEVM:
          this.logger.debug({
            at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
            message: `Subtracting ${convertedOrderAmount.toString()} ${sourceToken} for order cloid ${cloid} that has finalized bridging to HyperEVM`,
          });
          pendingRebalances[HYPEREVM][sourceToken] = (pendingRebalances[HYPEREVM][sourceToken] ?? bnZero).sub(
            convertedOrderAmount
          );
        }
        assert(
          usdtPendingRebalanceAmount.eq(bnZero) && usdcPendingRebalanceAmount.eq(bnZero),
          "Unfinalized bridge amount to HyperEVM should be 0 after evaluating all orders with status PENDING_BRIDGE_TO_HYPEREVM"
        );
      }
    });

    // For each pending withdrawal from Hypercore, check if it has finalized, and if it has, subtract its virtual balance from HyperEVM.
    const pendingWithdrawalsFromHypercore = await this._redisGetPendingWithdrawals();
    if (pendingWithdrawalsFromHypercore.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
        message: `Pending withdrawal from Hypercore cloids: ${pendingWithdrawalsFromHypercore.join(", ")}`,
      });
    }
    let unfinalizedUsdtWithdrawalAmount = await this._getUnfinalizedWithdrawalAmountFromHypercore(
      "USDT",
      this._getFromTimestamp() * 1000
    );
    let unfinalizedUsdcWithdrawalAmount = await this._getUnfinalizedWithdrawalAmountFromHypercore(
      "USDC",
      this._getFromTimestamp() * 1000
    );
    for (const cloid of pendingWithdrawalsFromHypercore) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationToken } = orderDetails;
      const matchingFill = await this._getMatchingFillForCloid(cloid, this._getFromTimestamp() * 1000);
      if (!matchingFill) {
        throw new Error(`No matching fill found for cloid ${cloid} that has status PENDING_WITHDRAWAL_FROM_HYPERCORE`);
      }
      // Check if order finalized and if so, subtract its virtual balance from HyperEVM.
      const initiatedWithdrawals = await this._getInitiatedWithdrawalsFromHypercore(
        orderDetails.destinationToken,
        matchingFill.details.time
      );
      if (initiatedWithdrawals.length === 0) {
        // No initiated withdrawal found, definitely cannot be finalized:
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
          message: `Cannot find any initiated withdrawals that could correspond to cloid ${cloid} which filled at ${matchingFill.details.time}, skipping`,
        });
        continue;
      }
      const destinationTokenMeta = this._getTokenMeta(destinationToken);
      const expectedAmountToReceive = ConvertDecimals(
        destinationTokenMeta.coreDecimals,
        destinationTokenMeta.evmDecimals
      )(matchingFill.amountToWithdraw);
      const unfinalizedWithdrawalAmount =
        destinationToken === "USDT" ? unfinalizedUsdtWithdrawalAmount : unfinalizedUsdcWithdrawalAmount;
      if (unfinalizedWithdrawalAmount.gte(expectedAmountToReceive)) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
          message: `Guessing order ${cloid} has not finalized yet because the unfinalized amount ${unfinalizedWithdrawalAmount.toString()} is >= than the expected withdrawal amount ${expectedAmountToReceive.toString()}`,
        });
        if (destinationToken === "USDT") {
          unfinalizedUsdtWithdrawalAmount = unfinalizedUsdtWithdrawalAmount.sub(expectedAmountToReceive);
        } else {
          unfinalizedUsdcWithdrawalAmount = unfinalizedUsdcWithdrawalAmount.sub(expectedAmountToReceive);
        }
        continue;
      }
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
        message: `Withdrawal for order ${cloid} has finalized, subtracting its virtual balance of ${expectedAmountToReceive.toString()} from HyperEVM`,
      });
      pendingRebalances[HYPEREVM][destinationToken] = (pendingRebalances[HYPEREVM][destinationToken] ?? bnZero).sub(
        matchingFill.amountToWithdraw
      );
    }

    // For any pending orders at all, we should add a virtual balance to the destination chain. This includes
    // orders with statuses: { PENDING_BRIDGE_TO_HYPEREVM, PENDING_SWAP, PENDING_DEPOSIT_TO_HYPERCORE, PENDING_WITHDRAWAL_FROM_HYPERCORE },
    const pendingSwaps = await this._redisGetPendingSwaps();
    const pendingDepositsToHypercore = await this._redisGetPendingDepositsToHypercore();
    if (pendingSwaps.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
        message: `Pending swap cloids: ${pendingSwaps.join(", ")}`,
        pendingSwaps: pendingSwaps.length,
      });
    }
    if (pendingDepositsToHypercore.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
        message: `Pending deposit to Hypercore cloids: ${pendingDepositsToHypercore.join(", ")}`,
        pendingDepositsToHypercore: pendingDepositsToHypercore.length,
      });
    }
    const pendingCloids = new Set<string>(
      pendingSwaps
        .concat(pendingWithdrawalsFromHypercore)
        .concat(pendingDepositsToHypercore)
        .concat(pendingBridgeToHyperevm)
    ).values();
    for (const cloid of pendingCloids) {
      // Filter this to match pending rebalance routes:
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
        at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
        message: `Adding ${convertedAmount.toString()} ${destinationToken} for pending order cloid ${cloid} to destination chain ${destinationChain}`,
      });
      pendingRebalances[destinationChain] ??= {};
      pendingRebalances[destinationChain][destinationToken] = (
        pendingRebalances[destinationChain][destinationToken] ?? bnZero
      ).add(convertedAmount);
    }
    return pendingRebalances;
  }

  /** ****************************************************
   *
   * REDIS HELPER FUNCTIONS
   *
   ****************************************************/

  protected _redisGetOrderStatusKey(status: STATUS): string {
    let orderStatusKey: string;
    switch (status) {
      case STATUS.PENDING_BRIDGE_TO_HYPEREVM:
        orderStatusKey = this.REDIS_KEY_PENDING_BRIDGE_TO_HYPEREVM;
        break;
      case STATUS.PENDING_DEPOSIT_TO_HYPERCORE:
        orderStatusKey = this.REDIS_KEY_PENDING_DEPOSIT_TO_HYPERCORE;
        break;
      case STATUS.PENDING_SWAP:
        orderStatusKey = this.REDIS_KEY_PENDING_SWAP;
        break;
      case STATUS.PENDING_WITHDRAWAL_FROM_HYPERCORE:
        orderStatusKey = this.REDIS_KEY_PENDING_WITHDRAWAL_FROM_HYPERCORE;
        break;
      default:
        throw new Error(`Invalid status: ${status}`);
    }
    return orderStatusKey;
  }

  async _redisGetPendingSwaps(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_SWAP);
    return sMembers;
  }

  async _redisGetPendingBridgeToHyperevm(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_BRIDGE_TO_HYPEREVM);
    return sMembers;
  }

  async _redisGetPendingDepositsToHypercore(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_DEPOSIT_TO_HYPERCORE);
    return sMembers;
  }

  async _redisGetPendingWithdrawals(): Promise<string[]> {
    const sMembers = await this.redisCache.sMembers(this.REDIS_KEY_PENDING_WITHDRAWAL_FROM_HYPERCORE);
    return sMembers;
  }
}
