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
  MAX_SAFE_ALLOWANCE,
  paginatedEventQuery,
  Signer,
  toBN,
  toBNWei,
  winston,
  forEachAsync,
  ZERO_ADDRESS,
  truncate,
  getCurrentTime,
  getTokenInfoFromSymbol,
  getUserNonFundingLedgerUpdates,
  getOpenOrders,
  getSpotClearinghouseState,
  getUserFees,
  getL2Book,
  getUserFillsByTime,
} from "../../utils";
import { RebalanceRoute } from "../rebalancer";
import * as hl from "@nktkas/hyperliquid";
import { BaseAdapter, OrderDetails } from "./baseAdapter";
import { RebalancerConfig } from "../RebalancerConfig";
const { HYPEREVM } = CHAIN_IDs;

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
  coreDecimals: number;
}

// HyperEVM address of CoreDepositWallet used to facilitates deposits and withdrawals with Hypercore.
const USDC_CORE_DEPOSIT_WALLET_ADDRESS = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24";

// This adapter can be used to swap stables in Hyperliquid. This is preferable to swapping on source or destination
// prior to bridging because most chains have high fees for stablecoin swaps on DEX's, whereas bridging from OFT/CCTP
// into HyperEVM is free (or 0.01% for fast transfers) and then swapping on Hyperliquid is very cheap compared to DEX's.
// We should continually re-evaluate whether hyperliquid stablecoin swaps are indeed the cheapest option.
export class HyperliquidStablecoinSwapAdapter extends BaseAdapter {
  REDIS_PREFIX = "hyperliquid-stablecoin-swap:";

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
      minimumOrderSize: 11, // Added buffer to minimum to account for price volatility.
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
      minimumOrderSize: 11, // Added buffer to minimum to account for price volatility.
      szDecimals: 2,
      pxDecimals: 5, // Max(5, 8 - szDecimals): https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
      isBuy: true,
    },
  };

  private tokenMeta: { [symbol: string]: TOKEN_META } = {
    USDT: {
      evmSystemAddress: EvmAddress.from("0x200000000000000000000000000000000000010C"),
      tokenIndex: 268,
      coreDecimals: 8,
    },
    USDC: {
      evmSystemAddress: EvmAddress.from("0x2000000000000000000000000000000000000000"),
      tokenIndex: 0,
      coreDecimals: 8,
    },
  };

  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {
    super(logger, config, baseSigner);
  }

  // ////////////////////////////////////////////////////////////
  // PUBLIC METHODS
  // ////////////////////////////////////////////////////////////

  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    await super.initialize(_availableRoutes.filter((route) => route.adapter === "hyperliquid"));

    await forEachAsync(this.availableRoutes, async (route) => {
      const { sourceToken, destinationToken, sourceChain, destinationChain } = route;
      const expectedName = `${sourceToken}-${destinationToken}`;
      if (!this.spotMarketMeta[expectedName]) {
        throw new Error(`Missing spotMarketMeta data for ${expectedName}`);
      }
      assert(
        this._chainIsBridgeable(destinationChain, destinationToken),
        `Destination chain ${getNetworkName(
          destinationChain
        )} is not a valid final destination chain for token ${destinationToken} because it is either not a OFT or a CCTP bridge`
      );
      assert(
        this._chainIsBridgeable(sourceChain, sourceToken),
        `Source chain ${getNetworkName(
          sourceChain
        )} is not a valid source chain for token ${sourceToken} because it is either not a OFT or a CCTP bridge`
      );
    });

    // Check allowance for CoreDepositWallet required to deposit USDC to Hypercore.
    const provider_999 = await getProvider(HYPEREVM);
    const connectedSigner_999 = this.baseSigner.connect(provider_999);
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

    const { sourceToken, sourceChain, destinationChain, destinationToken } = rebalanceRoute;
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const sourceTokenInfo = getTokenInfoFromSymbol(sourceToken, sourceChain);
    assert(
      amountToTransfer.gte(toBNWei(spotMarketMeta.minimumOrderSize, sourceTokenInfo.decimals)),
      `Max amount to transfer ${amountToTransfer.toString()} is less than minimum order size ${toBNWei(
        spotMarketMeta.minimumOrderSize,
        sourceTokenInfo.decimals
      ).toString()}`
    );

    // TODO: The amount we transfer in here might not be fully placed into an order dependning on the market's
    // minimum tick size (i.e. szDecimals and pxDecimals), so we might be left with some dust in the account.
    // We should figure out how to only transfer in exactly how many tokens we intend to set the sz to, but we can
    // never be perfect about this because there is time between when the deposit into HL finalizes and there is a chance
    // the mid market price can change.

    const cloid = await this._redisGetNextCloid();

    if (sourceChain !== HYPEREVM) {
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

      const amountReceivedFromBridge = await this._bridgeToChain(sourceToken, sourceChain, HYPEREVM, amountToTransfer);

      await this._redisCreateOrder(cloid, STATUS.PENDING_BRIDGE_TO_HYPEREVM, rebalanceRoute, amountReceivedFromBridge);
    } else {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.initializeRebalance",
        message: `Creating new order ${cloid} by depositing ${sourceToken} from HyperEVM to HyperCore`,
        destinationToken,
        destinationChain: getNetworkName(destinationChain),
        amountToTransfer: amountToTransfer.toString(),
      });

      await this._depositToHypercore(sourceToken, amountToTransfer);
      await this._redisCreateOrder(cloid, STATUS.PENDING_DEPOSIT_TO_HYPERCORE, rebalanceRoute, amountToTransfer);
    }
  }

  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();

    const pendingBridgeToHyperevm = await this._redisGetPendingBridgesPreDeposit();
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
        HYPEREVM,
        this._getTokenInfo(sourceToken, HYPEREVM).address.toNative()
      );
      const amountConverter = this._getAmountConverter(
        orderDetails.sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address,
        HYPEREVM,
        this._getTokenInfo(sourceToken, HYPEREVM).address
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

    const pendingBridgeToHypercore = await this._redisGetPendingDeposits();
    if (pendingBridgeToHypercore.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending deposit to Hypercore",
        pendingBridgeToHypercore,
      });
    }
    for (const cloid of pendingBridgeToHypercore) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const orderResult = await this._createHlOrder(orderDetails, cloid);
      if (orderResult) {
        await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_DEPOSIT_TO_HYPERCORE, STATUS.PENDING_SWAP);
        // Wait some time after placing a new order to allow for it to execute and hopefully be immediately filled
        // and reflected in our HL balance. Then in the next step we can withdraw it from Hypercore.
        await this._wait(10);
      }
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
      openOrders = await getOpenOrders(infoClient, { user: this.baseSignerAddress.toNative() });
      if (openOrders.length > 0) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: "Open orders",
          openOrders,
        });
      }
    }
    for (const cloid of pendingSwaps) {
      const matchingFill = await this._getMatchingFillForCloid(cloid);
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
        const success = await this._withdrawToHyperevm(existingOrder.destinationToken, matchingFill.amountToWithdraw);
        if (success) {
          await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_SWAP, STATUS.PENDING_WITHDRAWAL_FROM_HYPERCORE);
        }
      } else if (!matchingOpenOrder) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Order ${cloid} was never filled and no longer exists, creating new order`,
        });
        const existingOrder = await this._redisGetOrderDetails(cloid);
        await this._createHlOrder(existingOrder, cloid);
      } else {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Order ${cloid} is still unfilled`,
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
      const { destinationToken, destinationChain } = orderDetails;
      const matchingFill = await this._getMatchingFillForCloid(cloid);
      if (!matchingFill) {
        throw new Error(`No matching fill found for cloid ${cloid} that has status PENDING_WITHDRAWAL_FROM_HYPERCORE`);
      }

      // Only proceed to update the order status if it has finalized:
      const initiatedWithdrawals = await this._getInitiatedWithdrawalsFromHypercore(
        destinationToken,
        matchingFill.details.time
      );
      if (initiatedWithdrawals.length === 0) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Cannot find any initiated withdrawals that could correspond to cloid ${cloid} which filled at ${matchingFill.details.time}, waiting`,
        });
        continue;
      }
      const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationChain);
      const destinationTokenMeta = this._getTokenMeta(destinationToken);
      const expectedAmountToReceive = ConvertDecimals(
        destinationTokenMeta.coreDecimals,
        destinationTokenInfo.decimals
      )(matchingFill.amountToWithdraw);
      const unfinalizedWithdrawalAmount =
        unfinalizedWithdrawalAmounts[destinationToken] ??
        (await this._getUnfinalizedWithdrawalAmountFromHypercore(destinationToken, matchingFill.details.time));
      // If HL were to impose a withdraw fee then we'd need to subtract the estimated fee from the expectedAmountToReceive
      // here otherwise we might have received less than the expected amount on HyperEVM.
      if (unfinalizedWithdrawalAmount.gte(expectedAmountToReceive)) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Guessing order ${cloid} has not finalized yet because the unfinalized amount ${unfinalizedWithdrawalAmount.toString()} is >= than the expected withdrawal amount ${expectedAmountToReceive.toString()}`,
        });
        unfinalizedWithdrawalAmounts[destinationToken] = unfinalizedWithdrawalAmount.sub(expectedAmountToReceive);
        continue;
      }

      if (destinationChain === HYPEREVM) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Deleting order details from Redis with cloid ${cloid} because it has completed!`,
        });
      } else {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Sending order with cloid ${cloid} from HyperEVM to final destination chain ${destinationChain}, and deleting order details from Redis!`,
          expectedAmountToReceive: expectedAmountToReceive.toString(),
        });
        await this._bridgeToChain(destinationToken, HYPEREVM, destinationChain, expectedAmountToReceive);
      }
      // We no longer need this order information, so we can delete it:
      await this._redisDeleteOrder(cloid, STATUS.PENDING_WITHDRAWAL_FROM_HYPERCORE);
    }
  }

  async sweepIntermediateBalances(): Promise<void> {
    this._assertInitialized();

    // Only sweep if there are no orders currently being swapped or withdrawn, to avoid
    // accidentally withdrawing balances that are needed for in-flight orders.
    const [pendingSwaps, pendingWithdrawals] = await Promise.all([
      this._redisGetPendingSwaps(),
      this._redisGetPendingWithdrawals(),
    ]);
    if (pendingSwaps.length > 0 || pendingWithdrawals.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.sweepIntermediateBalances",
        message: "Skipping sweep because there are pending swaps or withdrawals",
        pendingSwaps: pendingSwaps.length,
        pendingWithdrawals: pendingWithdrawals.length,
      });
      return;
    }

    // Check each supported token's available balance on Hypercore and withdraw to HyperEVM
    // if it exceeds a minimum threshold.
    for (const token of Object.keys(this.tokenMeta)) {
      const tokenMeta = this._getTokenMeta(token);
      // Use a minimum threshold of 1 unit (in core decimals) to avoid sweeping dust.
      const minimumSweepThreshold = toBNWei(
        process.env.HYPERLIQUID_MINIMUM_SWEEP_THRESHOLD ?? 1,
        tokenMeta.coreDecimals
      );

      let availableBalance: BigNumber;
      try {
        availableBalance = await this._getAvailableBalanceForToken(token);
      } catch {
        // No balance found for this token on Hypercore, skip.
        continue;
      }

      if (availableBalance.gt(minimumSweepThreshold)) {
        const balanceReadable = fromWei(availableBalance, tokenMeta.coreDecimals);
        this.logger.info({
          at: "HyperliquidStablecoinSwapAdapter.sweepIntermediateBalances",
          message: `Sweeping ${balanceReadable} ${token} from Hypercore to HyperEVM`,
          availableBalance: availableBalance.toString(),
          minimumSweepThreshold: minimumSweepThreshold.toString(),
        });
        await this._withdrawToHyperevm(token, availableBalance.sub(minimumSweepThreshold));

        // @TODO Should we track this virtual balance from the withdrawal somewhere? I'd argue no, because for this balance
        // to be in this state and unassociated with any orders, then its already being counted as "untracked" balance,
        // so we don't need to add complexity and track it here.
      } else {
        const balanceReadable = fromWei(availableBalance, tokenMeta.coreDecimals);
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.sweepIntermediateBalances",
          message: `${token} balance on Hypercore (${balanceReadable}) is below minimum sweep threshold, skipping`,
          availableBalance: availableBalance.toString(),
          minimumSweepThreshold: minimumSweepThreshold.toString(),
        });
      }
    }
  }

  async getEstimatedCost(
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    debugLog: boolean
  ): Promise<BigNumber> {
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const { slippagePct, px } = await this._getLatestPrice(
      sourceToken,
      destinationToken,
      destinationChain,
      amountToTransfer
    );
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
    if (rebalanceRoute.sourceChain !== HYPEREVM) {
      bridgeToHyperEvmFee = await this._getBridgeFee(sourceChain, HYPEREVM, sourceToken, amountToTransfer);
    }

    // Bridge from HyperEVMFee:
    let bridgeFromHyperEvmFee = bnZero;
    if (rebalanceRoute.destinationChain !== HYPEREVM) {
      bridgeFromHyperEvmFee = await this._getBridgeFee(HYPEREVM, destinationChain, destinationToken, amountToTransfer);
    }

    // The only time we add an opportunity cost of capital component is when we require rebalancing via OFT from HyperEVM
    // because this is the only route amongst all CCTP/OFT routes that takes longer than ~20 minutes to complete. It takes
    // 11 hours and this is so much larger than the default bridging time that we need to charge something for the opportunity cost of capital.
    // @todo a better way to do this might be to use historical fills to calculate the relayer's
    // latest profitability % to forecast the opportunity cost of capital.
    const requiresOftBridgeFromHyperevm = destinationChain !== CHAIN_IDs.HYPEREVM && destinationToken === "USDT";
    const opportunityCostOfCapitalPct = requiresOftBridgeFromHyperevm
      ? this._getOpportunityCostOfCapitalPctForRebalanceTime(11 * 60 * 60 * 1000)
      : bnZero;
    const opportunityCostOfCapitalFixed = toBNWei(opportunityCostOfCapitalPct, 18)
      .mul(amountToTransfer)
      .div(toBNWei(100, 18));

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

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

    // For each order that is in the state of being bridged to HyperEVM, check if its bridged amount has arrived
    // on HyperEVM yet, and if it has, then we should subtract its virtual balance from HyperEVM since that balance
    // will soon be deposited into Hypercore.
    const pendingBridgeToHyperevm = await this._redisGetPendingBridgesPreDeposit();
    if (pendingBridgeToHyperevm.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
        message: `Pending bridge to Hyperevm cloids: ${pendingBridgeToHyperevm.join(", ")}`,
      });
    }
    pendingRebalances[HYPEREVM] ??= {};
    const pendingBridgeFinalizations: { [sourceChain: number]: { [token: string]: BigNumber } } = {};
    await forEachAsync(Array.from(this.allSourceChains), async (sourceChain) => {
      if (sourceChain !== HYPEREVM) {
        for (const cloid of pendingBridgeToHyperevm) {
          const orderDetails = await this._redisGetOrderDetails(cloid);
          const { sourceToken, amountToTransfer } = orderDetails;
          if (orderDetails.sourceChain !== sourceChain) {
            continue;
          }

          if (!pendingBridgeFinalizations[sourceChain]) {
            pendingBridgeFinalizations[sourceChain] = {};
          }
          if (!pendingBridgeFinalizations[sourceChain][sourceToken]) {
            pendingBridgeFinalizations[sourceChain][sourceToken] = await this[
              sourceToken === "USDT" ? "_getUnfinalizedOftBridgeAmount" : "_getUnfinalizedCctpBridgeAmount"
            ](sourceChain, HYPEREVM);
          }
          const unfinalizedBridgeAmountToHyperevm = pendingBridgeFinalizations[sourceChain][sourceToken];

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
          // The algorithm here is a bit subtle. We can't easily associate pending OFT/CCTP rebalances with order cloids,
          // unless we saved the transaction hash down at the time of creating the cloid and initiating the bridge to
          // hyperevm. (If we did do that, then we'd need to keep track of pending rebalances and we'd have to
          // update them in the event queries above). The alternative implementation we use is to track the total
          // pending unfinalized amount, and subtract any order expected amounts from the pending amount. We can then
          // back into how many of these pending bridges to HyperEVM have finalized.
          if (unfinalizedBridgeAmountToHyperevm.gte(convertedOrderAmount)) {
            this.logger.debug({
              at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
              message: `Order cloid ${cloid} is possibly pending finalization to Hyperevm still (remaining pending amount: ${unfinalizedBridgeAmountToHyperevm.toString()} ${sourceToken}, order expected amount: ${convertedOrderAmount.toString()})`,
            });

            pendingBridgeFinalizations[sourceChain][sourceToken] =
              pendingBridgeFinalizations[sourceChain][sourceToken].sub(convertedOrderAmount);
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
    // Hypercore withdrawals are fast, so setting a lookback of 6 hours should capture any unfinalized withdrawals.
    const withdrawalInitiatedLookbackPeriod = 6 * 60 * 60;
    const withdrawalInitiatedFromTimestamp = getCurrentTime() - withdrawalInitiatedLookbackPeriod;
    let [unfinalizedUsdtWithdrawalAmount, unfinalizedUsdcWithdrawalAmount] = await Promise.all([
      this._getUnfinalizedWithdrawalAmountFromHypercore("USDT", withdrawalInitiatedFromTimestamp * 1000),
      this._getUnfinalizedWithdrawalAmountFromHypercore("USDC", withdrawalInitiatedFromTimestamp * 1000),
    ]);
    for (const cloid of pendingWithdrawalsFromHypercore) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationToken, destinationChain } = orderDetails;
      const matchingFill = await this._getMatchingFillForCloid(cloid);
      if (!matchingFill) {
        throw new Error(`No matching fill found for cloid ${cloid} that has status PENDING_WITHDRAWAL_FROM_HYPERCORE`);
      }
      // Check if order finalized and if so, subtract its virtual balance from HyperEVM.
      const initiatedWithdrawals = await this._getInitiatedWithdrawalsFromHypercore(
        destinationToken,
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
      const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationChain);
      const expectedAmountToReceive = ConvertDecimals(
        destinationTokenMeta.coreDecimals,
        destinationTokenInfo.decimals
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
        expectedAmountToReceive
      );
    }

    // For any pending orders at all, we should add a virtual balance to the destination chain. This includes
    // orders with statuses: { PENDING_BRIDGE_TO_HYPEREVM, PENDING_SWAP, PENDING_DEPOSIT_TO_HYPERCORE, PENDING_WITHDRAWAL_FROM_HYPERCORE },
    const pendingSwaps = await this._redisGetPendingSwaps();
    const pendingDepositsToHypercore = await this._redisGetPendingDeposits();
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

  // ////////////////////////////////////////////////////////////
  // PRIVATE HELPER METHODS
  // ////////////////////////////////////////////////////////////

  private async _getAvailableBalanceForToken(token: string): Promise<BigNumber> {
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const spotClearingHouseState = await getSpotClearinghouseState(infoClient, {
      user: this.baseSignerAddress.toNative(),
    });

    const balanceToken = spotClearingHouseState.balances.find(
      (balance) => balance.coin === this._remapTokenSymbolToHlSymbol(token)
    );
    if (!balanceToken) {
      throw new Error(`No balance found in spotClearingHouseState for token: ${token}`);
    }

    const tokenMeta = this._getTokenMeta(token);
    const availableBalance = toBNWei(balanceToken.total, tokenMeta.coreDecimals).sub(
      toBNWei(balanceToken.hold, tokenMeta.coreDecimals)
    );

    return availableBalance;
  }

  private async _getUserTakerFeePct(skipCache = false): Promise<BigNumber> {
    const cacheKey = "hyperliquid-user-fees";

    if (!skipCache) {
      const cached = await this.redisCache.get<string>(cacheKey);
      if (cached) {
        return BigNumber.from(cached);
      }
    }
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const userFees = await getUserFees(infoClient, { user: this.baseSignerAddress.toNative() });
    const takerBaseFee = Number(userFees.userSpotCrossRate);
    const takerFee = takerBaseFee * 0.2; // for stable pairs, fee is 20% of the taker base fee
    const takerFeePct = toBNWei(takerFee.toFixed(18), 18).mul(100);

    // Reset cache if we've fetched a new API response.
    await this.redisCache.set(cacheKey, takerFeePct.toString()); // Use default TTL which is a long time as
    // this response is not expected to change frequently.
    return takerFeePct;
  }

  private async _createHlOrder(
    orderDetails: OrderDetails,
    cloid: string
  ): Promise<ReturnType<typeof this._placeMarketOrder> | undefined> {
    const { sourceToken, sourceChain, amountToTransfer } = orderDetails;
    const sourceTokenMeta = this._getTokenMeta(sourceToken);
    const sourceTokenInfo = getTokenInfoFromSymbol(sourceToken, sourceChain);

    const availableBalance = await this._getAvailableBalanceForToken(sourceToken);
    const availableBalanceEvmDecimals = ConvertDecimals(
      sourceTokenMeta.coreDecimals,
      sourceTokenInfo.decimals
    )(availableBalance);
    if (availableBalanceEvmDecimals.lt(amountToTransfer)) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter._createHlOrder",
        message: `Available balance for input token: ${sourceToken} (${availableBalanceEvmDecimals.toString()}) is less than amount to transfer: ${amountToTransfer.toString()}`,
      });
      return;
    }
    this.logger.debug({
      at: "HyperliquidStablecoinSwapAdapter._createHlOrder",
      message: `Sufficient balance to place limit order for cloid ${cloid}`,
      availableBalanceEvmDecimals: availableBalanceEvmDecimals.toString(),
      requiredBalance: amountToTransfer.toString(),
    });
    return await this._placeMarketOrder(orderDetails, cloid);
  }

  private async _getLatestPrice(
    sourceToken: string,
    destinationToken: string,
    destinationChain: number,
    amountToTransfer: BigNumber
  ): Promise<{ px: string; slippagePct: number }> {
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const l2Book = await getL2Book(infoClient, { coin: spotMarketMeta.name });
    const bids = l2Book.levels[0];
    const asks = l2Book.levels[1];

    const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationChain);
    const sideOfBookToTraverse = spotMarketMeta.isBuy ? asks : bids;
    const bestPx = Number(sideOfBookToTraverse[0].px);
    let szFilledSoFar = bnZero;
    const maxPxReached = sideOfBookToTraverse.find((level) => {
      // Note: sz is always denominated in the base asset, so if we are buying, then the amountToTransfer (i.e.
      // the amount that we want to buy of the base asset) is denominated in the quote asset and we need to convert it
      // into the base asset.
      const sz = spotMarketMeta.isBuy ? Number(level.sz) * Number(level.px) : Number(level.sz);
      const szWei = toBNWei(truncate(sz, destinationTokenInfo.decimals));
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

  private async _placeMarketOrder(
    orderDetails: OrderDetails,
    cloid: string
  ): Promise<ReturnType<typeof this._placeLimitOrder> | undefined> {
    const { sourceToken, destinationToken, destinationChain, amountToTransfer } = orderDetails;
    const { px } = await this._getLatestPrice(sourceToken, destinationToken, destinationChain, amountToTransfer);
    return await this._placeLimitOrder(orderDetails, cloid, px);
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
    cloid: string
  ): Promise<{ details: any; amountToWithdraw: BigNumber } | undefined> {
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    // Any fill that we are searching for in this client shouldn't be more than 24 hours old:
    const lookbackPeriodSeconds = 24 * 60 * 60;
    const fromTimestampSeconds = getCurrentTime() - lookbackPeriodSeconds;
    const userFills = await getUserFillsByTime(infoClient, {
      user: this.baseSignerAddress.toNative(),
      startTime: fromTimestampSeconds * 1000, // @dev Time here is in milliseconds.
    });

    const matchingFill = userFills.find((fill) => fill.cloid === cloid);
    if (!matchingFill) {
      return undefined;
    }
    const existingOrder = await this._redisGetOrderDetails(cloid);
    const { sourceToken, destinationToken, destinationChain } = existingOrder;
    const destinationTokenMeta = this._getTokenMeta(destinationToken);
    const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationChain);
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);

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
      truncate(Number(fromWei(amountToWithdraw, destinationTokenMeta.coreDecimals)), destinationTokenInfo.decimals),
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
    sourceChain: number,
    destinationToken: string,
    destinationChain: number,
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
    const sourceTokenInfo = getTokenInfoFromSymbol(sourceToken, sourceChain);
    const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationChain);
    const szNumber = Number(
      fromWei(sz, spotMarketMeta.isBuy ? destinationTokenInfo.decimals : sourceTokenInfo.decimals)
    );
    const szFormatted = truncate(szNumber, spotMarketMeta.szDecimals);
    assert(szFormatted >= spotMarketMeta.minimumOrderSize, "Max amount to transfer is less than minimum order size");
    return szFormatted;
  }

  private async _placeLimitOrder(
    orderDetails: OrderDetails,
    cloid: string,
    px: string
  ): Promise<ReturnType<typeof exchangeClient.order> | undefined> {
    const { sourceToken, sourceChain, destinationToken, destinationChain, amountToTransfer } = orderDetails;
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
    const sz = this._getSzForOrder(sourceToken, sourceChain, destinationToken, destinationChain, amountToTransfer, px);
    // sz is always in base units, so if we're buying the base unit then
    try {
      const orderDetails = {
        a: 10000 + spotMarketMeta.index, // Asset index + spot asset index prefix
        b: spotMarketMeta.isBuy, // Buy side (if true, buys quote asset else sells quote asset for base asset)
        p: px, // Price
        s: sz, // Size
        r: false, // Reduce only
        t: { limit: { tif: "Ioc" as const } },
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
      return result;
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

  private async _withdrawToHyperevm(
    destinationToken: string,
    amountToWithdrawCorePrecision: BigNumber
  ): Promise<boolean> {
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

    // Check that we have enough balance to withdraw. Since we do this by calling the CoreWriter, if we don't have enough
    // balance then the withdrawal won't revert on-chain but it'll fail on Hypercore silently.
    const availableBalance = await this._getAvailableBalanceForToken(destinationToken);
    if (availableBalance.lt(amountToWithdrawCorePrecision)) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter._withdrawToHyperevm",
        message: `Not enough balance to withdraw ${destinationToken} from Core to EVM. Available balance: ${availableBalance.toString()}`,
        availableBalance: availableBalance.toString(),
      });
      return false;
    }

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
      availableBalance: availableBalance.toString(),
      amountToWithdrawCorePrecision: amountToWithdrawCorePrecision.toString(),
    });

    // Note: I'd like this to work via the multicaller client or runTransaction but the .wait() seems to fail.
    // Note: If sending multicaller client txn, unpermissioned:false and nonMulticall:true must be set.
    const txn = await coreWriterContract.sendRawAction(bytes);
    this.logger.debug({
      at: "HyperliquidStablecoinSwapAdapter._withdrawToHyperevm",
      message: `Withdrew ${amountToWithdraw} ${destinationToken} from Hypercore to HyperEVM`,
      txn: blockExplorerLink(txn.hash, HYPEREVM),
    });
    return true;
  }

  private async _depositToHypercore(sourceToken: string, amountToDepositEvmPrecision: BigNumber): Promise<void> {
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
    withdrawalInitiatedEarliestTimestampMilliseconds: number
  ): Promise<any[]> {
    const tokenMeta = this._getTokenMeta(destinationToken);
    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const initiatedWithdrawals = (
      await getUserNonFundingLedgerUpdates(infoClient, {
        user: this.baseSignerAddress.toNative(),
        startTime: withdrawalInitiatedEarliestTimestampMilliseconds,
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
    withdrawalInitiatedEarliestTimestampMilliseconds: number
  ): Promise<BigNumber> {
    const provider = await getProvider(HYPEREVM);
    // @dev We should set the from timestamp of the finalized event search config to some value conservatively
    // before the withdrawal initiated earliest timestamp to make sure that we're not missing any finalized events.
    // Setting the from block equal to 12 hours before the withdrawal initiated earliest timestamp should be a good
    // default because withdrawals from Hypercore should resolve in ~15 minutes typically.
    const finalizedWithdrawalLookbackPeriodSeconds = 12 * 60 * 60;
    const finalizedWithdrawalFromTimestamp =
      Math.floor(withdrawalInitiatedEarliestTimestampMilliseconds / 1000) - finalizedWithdrawalLookbackPeriodSeconds;
    const finalizedWithdrawalEventSearchConfig = await this._getEventSearchConfig(
      HYPEREVM,
      finalizedWithdrawalFromTimestamp
    );
    const hyperevmToken = new Contract(
      this._getTokenInfo(destinationToken, HYPEREVM).address.toNative(),
      ERC20.abi,
      this.baseSigner.connect(provider)
    );
    const destinationTokenMeta = this._getTokenMeta(destinationToken);
    const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, HYPEREVM);
    const [finalizedWithdrawals, initiatedWithdrawals] = await Promise.all([
      paginatedEventQuery(
        hyperevmToken,
        hyperevmToken.filters.Transfer(
          destinationToken === "USDC"
            ? USDC_CORE_DEPOSIT_WALLET_ADDRESS
            : destinationTokenMeta.evmSystemAddress.toNative(),
          this.baseSignerAddress.toNative()
        ),
        finalizedWithdrawalEventSearchConfig
      ),
      this._getInitiatedWithdrawalsFromHypercore(destinationToken, withdrawalInitiatedEarliestTimestampMilliseconds),
    ]);

    let unfinalizedWithdrawalAmount = bnZero;
    const finalizedWithdrawalTxnHashes = new Set<string>();
    for (const initiated of initiatedWithdrawals) {
      const withdrawalAmount = toBNWei(initiated.delta.amount, destinationTokenInfo.decimals);
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
}
