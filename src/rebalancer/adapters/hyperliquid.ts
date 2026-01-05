import { RedisCache } from "../../caching/RedisCache";
import { AugmentedTransaction, MultiCallerClient } from "../../clients";
import {
  assert,
  BigNumber,
  blockExplorerLink,
  bnUint32Max,
  bnZero,
  CHAIN_IDs,
  Contract,
  ConvertDecimals,
  createFormatFunction,
  ERC20,
  ethers,
  EventSearchConfig,
  EvmAddress,
  fixedPointAdjustment,
  formatToAddress,
  fromWei,
  getBlockForTimestamp,
  getCctpDomainForChainId,
  getCctpV2TokenMessenger,
  getEndpointId,
  getMessengerEvm,
  getNetworkName,
  getProvider,
  getRedisCache,
  getV2DepositForBurnMaxFee,
  isDefined,
  isStargateBridge,
  MAX_SAFE_ALLOWANCE,
  MessagingFeeStruct,
  paginatedEventQuery,
  roundAmountToSend,
  SendParamStruct,
  Signer,
  toBN,
  toBNWei,
  TOKEN_SYMBOLS_MAP,
  winston,
  ZERO_ADDRESS,
} from "../../utils";
import { RebalanceRoute } from "../rebalancer";
import * as hl from "@nktkas/hyperliquid";
import { CCTP_MAX_SEND_AMOUNT, IOFT_ABI_FULL, OFT_DEFAULT_FEE_CAP, OFT_FEE_CAP_OVERRIDES } from "../../common";
import { BaseAdapter, OrderDetails } from "./baseAdapter";
import { RebalancerConfig } from "../RebalancerConfig";
import { utils as sdkUtils } from "@across-protocol/sdk";

enum STATUS {
  PENDING_BRIDGE_TO_HYPEREVM,
  PENDING_SWAP,
  PENDING_WITHDRAWAL_FROM_HYPERCORE,
  PENDING_DEPOSIT_TO_HYPERCORE,
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
  REDIS_KEY_PENDING_BRIDGE_TO_HYPEREVM = this.REDIS_PREFIX + "pending-bridge-to-hyperliquid";
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

  private availableRoutes: RebalanceRoute[];

  private multicallerClient: MultiCallerClient;

  private maxSlippagePct = 0.02; // @todo make this configurable

  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {
    super(logger);
  }

  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    const { HYPEREVM } = CHAIN_IDs;
    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    const provider_999 = await getProvider(HYPEREVM);
    const connectedSigner_999 = this.baseSigner.connect(provider_999);
    this.redisCache = (await getRedisCache(this.logger)) as RedisCache;
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

    // CoreDepositWallet required to deposit USDC to Hypercore.
    const usdc = new Contract(TOKEN_SYMBOLS_MAP.USDC.addresses[HYPEREVM], ERC20.abi, connectedSigner_999);
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
    const cctpMessenger = await this._getCctpMessenger(HYPEREVM);
    const cctpAllowance = await usdc.allowance(this.baseSignerAddress.toNative(), cctpMessenger.address);
    if (cctpAllowance.lt(toBN(MAX_SAFE_ALLOWANCE).div(2))) {
      this.multicallerClient.enqueueTransaction({
        contract: usdc,
        chainId: HYPEREVM,
        method: "approve",
        nonMulticall: true,
        unpermissioned: false,
        args: [cctpMessenger.address, MAX_SAFE_ALLOWANCE],
        message: "Approved USDC for CCTP Messenger",
        mrkdwn: "Approved USDC for CCTP Messenger",
      });
    }

    const usdt = new Contract(TOKEN_SYMBOLS_MAP.USDT.addresses[HYPEREVM], ERC20.abi, connectedSigner_999);
    const oftMessenger = await this._getOftMessenger(HYPEREVM);
    const oftAllowance = await usdt.allowance(this.baseSignerAddress.toNative(), oftMessenger.address);
    if (oftAllowance.lt(toBN(MAX_SAFE_ALLOWANCE).div(2))) {
      this.multicallerClient.enqueueTransaction({
        contract: usdt,
        chainId: HYPEREVM,
        method: "approve",
        nonMulticall: true,
        unpermissioned: false,
        args: [oftMessenger.address, MAX_SAFE_ALLOWANCE],
        message: "Approved USDT for OFT Messenger",
        mrkdwn: "Approved USDT for OFT Messenger",
      });
    }

    await this.multicallerClient.executeTxnQueues();
    this.initialized = true;
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

    // If source token is not USDC, USDT, or USDH, throw.
    // If destination token is same as source token, throw.
    // If source token is USDH then throw if source chain is not HyperEVM.
    // If source chain is not HyperEVM, then initiate CCTP/OFT transfer to HyperEVM and save order
    //     with status PENDING_BRIDGE_TO_HYPEREVM. Save the transfer under BRIDGE_TO_HYPEREVM in order to correctly
    //     mark the order status.
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

      // TODO: If depositing via CCTP, we can actually deposit directly into Hypercore and if so then we should progress
      // the status to PENDING_SWAP: https://developers.circle.com/cctp/transfer-usdc-from-ethereum-to-hypercore
      await this._bridgeToChain(
        rebalanceRoute.sourceToken,
        rebalanceRoute.sourceChain,
        CHAIN_IDs.HYPEREVM,
        amountToTransfer
      );
      await this._redisCreateOrder(cloid, STATUS.PENDING_BRIDGE_TO_HYPEREVM, rebalanceRoute, amountToTransfer);
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

  async getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber> {
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const sourceTokenMeta = this._getTokenMeta(sourceToken);
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

    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const userFees = await infoClient.userFees({ user: this.baseSignerAddress.toNative() });
    const takerBaseFee = Number(userFees.userSpotCrossRate);
    const takerFee = takerBaseFee * 0.2; // for stable pairs, fee is 20% of the taker base fee
    const takerFeePct = toBNWei(takerFee.toFixed(18), 18).mul(100);
    const takerFeeFixed = takerFeePct.mul(amountToTransfer).div(toBNWei(100, 18));

    // Bridge to HyperEVM Fee:
    let bridgeToHyperEvmFee = bnZero;
    if (rebalanceRoute.sourceChain !== CHAIN_IDs.HYPEREVM) {
      if (rebalanceRoute.sourceToken === "USDC") {
        // CCTP Fee:
        const cctpV2FastTransferFeeBps = (await sdkUtils.getV2MinTransferFees(sourceChain, CHAIN_IDs.HYPEREVM)).fast;
        bridgeToHyperEvmFee = toBNWei(cctpV2FastTransferFeeBps, 18).mul(amountToTransfer).div(toBNWei(10000, 18));
      } else if (rebalanceRoute.sourceToken === "USDT") {
        // OFT Fee:
        const { feeStruct } = await this._getOftQuoteSend(sourceChain, CHAIN_IDs.HYPEREVM, amountToTransfer);
        // Convert native fee to USD and we assume that USD price is 1 and equivalent to the source/destination token.
        // This logic would need to change to support non stablecoin swaps.
        const nativeTokenSymbol = sdkUtils.getNativeTokenSymbol(sourceChain);
        const nativeTokenDecimals = TOKEN_SYMBOLS_MAP[nativeTokenSymbol].decimals;
        const allMids = await infoClient.allMids();
        const mid = allMids[this._remapTokenSymbolToHlSymbol(nativeTokenSymbol)];
        const nativeFeeUsd = toBNWei(mid).mul(feeStruct.nativeFee).div(toBNWei(1, nativeTokenDecimals));
        const nativeFeeSourceDecimals = ConvertDecimals(nativeTokenDecimals, sourceTokenMeta.evmDecimals)(nativeFeeUsd);
        bridgeToHyperEvmFee = nativeFeeSourceDecimals;
      }
    }

    // Bridge from HyperEVMFee:
    let bridgeFromHyperEvmFee = bnZero;
    if (rebalanceRoute.destinationChain !== CHAIN_IDs.HYPEREVM) {
      if (rebalanceRoute.destinationToken === "USDC") {
        // CCTP Fee:
        const cctpV2FastTransferFeeBps = (await sdkUtils.getV2MinTransferFees(CHAIN_IDs.HYPEREVM, destinationChain))
          .fast;
        bridgeFromHyperEvmFee = toBNWei(cctpV2FastTransferFeeBps, 18).mul(amountToTransfer).div(toBNWei(10000, 18));
      } else if (rebalanceRoute.destinationToken === "USDT") {
        // OFT Fee:
        const { feeStruct } = await this._getOftQuoteSend(CHAIN_IDs.HYPEREVM, destinationChain, amountToTransfer);
        // Convert native fee to USD and we assume that USD price is 1 and equivalent to the source/destination token.
        // This logic would need to change to support non stablecoin swaps.
        const nativeTokenSymbol = sdkUtils.getNativeTokenSymbol(CHAIN_IDs.HYPEREVM);
        const nativeTokenDecimals = TOKEN_SYMBOLS_MAP[nativeTokenSymbol].decimals;
        const allMids = await infoClient.allMids();
        const mid = allMids[this._remapTokenSymbolToHlSymbol(nativeTokenSymbol)];
        const nativeFeeUsd = toBNWei(mid).mul(feeStruct.nativeFee).div(toBNWei(1, nativeTokenDecimals));
        const nativeFeeSourceDecimals = ConvertDecimals(nativeTokenDecimals, sourceTokenMeta.evmDecimals)(nativeFeeUsd);
        bridgeFromHyperEvmFee = nativeFeeSourceDecimals;
      }
    }

    // - Opportunity cost of capital when withdrawing from 999. This takes 11 hours, i think we should add at least 10
    // bps for this. @todo a better way to do this might be to use historical fills to calculate the relayer's
    // latest profitability % to forecast the opportunity cost of capital.
    const opportunityCostOfCapitalBps = destinationChain !== CHAIN_IDs.HYPEREVM ? 10 : 0;
    const opportunityCostOfCapitalFixed = toBNWei(opportunityCostOfCapitalBps, 18)
      .mul(amountToTransfer)
      .div(toBNWei(10000, 18));

    const totalFee = spreadFee
      .add(slippage)
      .add(takerFeeFixed)
      .add(bridgeToHyperEvmFee)
      .add(bridgeFromHyperEvmFee)
      .add(opportunityCostOfCapitalFixed);

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

    return totalFee;

    // TOOD: Add the following fees:
  }

  private async _createHlOrder(orderDetails: OrderDetails, cloid: string): Promise<void> {
    const { sourceToken, amountToTransfer, destinationToken } = orderDetails;
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
      throw new Error(
        `Available balance for input token: ${sourceToken} (${availableBalanceEvmDecimals.toString()}) is less than amount to transfer: ${amountToTransfer.toString()}`
      );
    }

    // Fetch latest price for the market we're going to place an order for:
    const spotMarketMeta = this._getSpotMarketMetaForRoute(sourceToken, destinationToken);
    const spotMarketData = await infoClient.spotMetaAndAssetCtxs();
    const tokenData = spotMarketData[1].find((market) => market.coin === `@${spotMarketMeta.index}`);
    if (!tokenData) {
      throw new Error(`No token data found for spot market: ${spotMarketMeta.index}`);
    }

    // Check for open orders and available balance. If no open orders matching desired CLOID and available balance
    // is sufficient, then place order.

    await this._placeMarketOrder(orderDetails, cloid, this.maxSlippagePct);
  }

  private _getFromTimestamp(): number {
    return Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7; // 7 days ago
  }

  private async _getEventSearchConfig(chainId: number): Promise<EventSearchConfig> {
    const fromTimestamp = this._getFromTimestamp();
    const provider = await getProvider(chainId);
    const fromBlock = await getBlockForTimestamp(this.logger, chainId, fromTimestamp);
    const toBlock = await provider.getBlock("latest");
    const maxLookBack = this.config.maxBlockLookBack[chainId];
    return { from: fromBlock, to: toBlock.number, maxLookBack };
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
    const lastPollEnd = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7; // 7 days ago

    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const openOrders = await infoClient.openOrders({ user: this.baseSignerAddress.toNative() });
    if (openOrders.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
        message: "Open orders",
        openOrders,
      });
    }

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
      const { sourceToken, destinationToken, amountToTransfer, sourceChain } = orderDetails;
      // Check if we have enough balance on HyperEVM to progress the order status:
      const hyperevmBalance = await this._getBalance(
        CHAIN_IDs.HYPEREVM,
        TOKEN_SYMBOLS_MAP[destinationToken].addresses[CHAIN_IDs.HYPEREVM]
      );
      const amountConverter = this._getAmountConverter(
        orderDetails.sourceChain,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[sourceToken].addresses[sourceChain]),
        CHAIN_IDs.HYPEREVM,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[destinationToken].addresses[CHAIN_IDs.HYPEREVM])
      );
      const expectedAmountOnHyperevm = amountConverter(amountToTransfer);
      if (hyperevmBalance.lt(expectedAmountOnHyperevm)) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Not enough balance on HyperEVM to progress the order ${cloid} with status PENDING_BRIDGE_TO_HYPEREVM: ${expectedAmountOnHyperevm.toString()}`,
        });
      } else {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `We have balance on HyperEVM to bridge into Hypercore, initiating a deposit now for ${expectedAmountOnHyperevm.toString()} of ${sourceToken}`,
        });
        await this._depositToHypercore(sourceToken, expectedAmountOnHyperevm);
        await this._redisUpdateOrderStatus(
          cloid,
          STATUS.PENDING_BRIDGE_TO_HYPEREVM,
          STATUS.PENDING_DEPOSIT_TO_HYPERCORE
        );
      }
    }

    // Check pending swap statuses before checking pending deposits to hypercore otherwise we might place an order,
    // and attempt to replace it because it wasn't immediately executed.
    const pendingSwaps = await this._redisGetPendingSwaps();
    if (pendingSwaps.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending swap",
        pendingSwaps,
      });
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
      // See if cloid matches with an open order and user fill
      // If it has a user fill, then update its order status to next state:
      // If it doesn't have a user fill AND doesn't have an open order, then replace its order.
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
      // Either delete the order ecause it has completed or update the order status to PENDING_BRIDGE_TO_DESTINATION_CHAIN and initiate
      // a bridge to destination chain.
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
      if (unfinalizedWithdrawalAmount.gte(expectedAmountToReceive)) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Guessing order ${cloid} has not finalized yet because the unfinalized amount ${unfinalizedWithdrawalAmount.toString()} is >= than the expected withdrawal amount ${expectedAmountToReceive.toString()}`,
        });
        unfinalizedWithdrawalAmounts[orderDetails.destinationToken] =
          unfinalizedWithdrawalAmount.sub(expectedAmountToReceive);
        continue;
      }

      // At this point, we know the withdrawal has finalized.
      const hyperevmBalance = await this._getBalance(
        CHAIN_IDs.HYPEREVM,
        TOKEN_SYMBOLS_MAP[orderDetails.destinationToken].addresses[CHAIN_IDs.HYPEREVM]
      );
      if (hyperevmBalance.lt(expectedAmountToReceive)) {
        throw new Error(
          `Not enough balance on HyperEVM to cover the expected withdrawal amount: ${expectedAmountToReceive.toString()}`
        );
      }
      if (orderDetails.destinationChain === CHAIN_IDs.HYPEREVM) {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Deleting order details from Redis with cloid ${cloid} because it has completed!`,
        });
      } else {
        this.logger.debug({
          at: "HyperliquidStablecoinSwapAdapter.updateRebalanceStatuses",
          message: `Sending order with cloid ${cloid} to final destination chain ${orderDetails.destinationChain}, and deleting order details from Redis!`,
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
      const szWei = toBNWei(sz, tokenMeta.evmDecimals);
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

  private async _getBalance(chainId: number, tokenAddress: string): Promise<BigNumber> {
    const provider = await getProvider(chainId);
    const connectedSigner = this.baseSigner.connect(provider);
    const erc20 = new Contract(tokenAddress, ERC20.abi, connectedSigner);
    const balance = await erc20.balanceOf(this.baseSignerAddress.toNative());
    return BigNumber.from(balance.toString());
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
    const szFormatted = Number(Number(fromWei(sz, evmDecimals)).toFixed(spotMarketMeta.szDecimals));
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
    const hyperevmToken = TOKEN_SYMBOLS_MAP[sourceToken].addresses[HYPEREVM];
    const provider = await getProvider(HYPEREVM);
    const connectedSigner = this.baseSigner.connect(provider);
    const erc20 = new Contract(hyperevmToken, ERC20.abi, connectedSigner);
    const amountReadable = fromWei(amountToDepositEvmPrecision, TOKEN_SYMBOLS_MAP[sourceToken]?.decimals);
    let transaction: AugmentedTransaction;
    if (sourceToken === "USDC") {
      const allowance = await erc20.allowance(this.baseSignerAddress.toNative(), USDC_CORE_DEPOSIT_WALLET_ADDRESS);
      if (allowance.lt(amountToDepositEvmPrecision)) {
        throw new Error("Insufficient allowance to bridge USDC into Hypercore via CoreDepositWallet.deposit()");
      }
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

  private async _bridgeToChain(
    token: string,
    originChain: number,
    destinationChain: number,
    expectedAmountToTransfer: BigNumber
  ): Promise<void> {
    if (destinationChain === originChain) {
      throw new Error("origin and destination chain are the same");
    }

    const balance = await this._getBalance(originChain, TOKEN_SYMBOLS_MAP[token].addresses[originChain]);
    if (balance.lt(expectedAmountToTransfer)) {
      throw new Error(
        `Not enough balance on ${originChain} to bridge ${token} to ${destinationChain} for ${expectedAmountToTransfer.toString()}`
      );
    }

    const tokenMeta = this._getTokenMeta(token);
    switch (tokenMeta.bridgeName) {
      case "OFT":
        await this._sendOftBridge(originChain, destinationChain, expectedAmountToTransfer);
        break;
      case "CCTP":
        await this._sendCctpBridge(originChain, destinationChain, expectedAmountToTransfer);
        break;
      default:
        // This should be impossible because `bridgeName` is type BRIDGE_NAME.
        throw new Error(`Should never happen: Unsupported bridge name: ${tokenMeta.bridgeName}`);
    }
  }

  private async _sendCctpBridge(
    originChain: number,
    destinationChain: number,
    amountToBridge: BigNumber
  ): Promise<void> {
    // TODO: In the future, this could re-use a CCTPAdapter function.
    const cctpMessenger = await this._getCctpMessenger(originChain);
    const originUsdcToken = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[originChain]);
    // TODO: Don't always use fast mode, we should switch based on the expected fee and transfer size
    // incase a portion of the fee is fixed. The expected fee should be 1bp.
    const { maxFee, finalityThreshold } = await getV2DepositForBurnMaxFee(
      originUsdcToken,
      originChain,
      destinationChain,
      amountToBridge
    );
    const amountToSend = amountToBridge.sub(maxFee);
    if (amountToSend.gt(CCTP_MAX_SEND_AMOUNT)) {
      // TODO: Handle this case by sending multiple transactions.
      throw new Error(
        `Amount to send ${amountToSend.toString()} is greater than CCTP_MAX_SEND_AMOUNT ${CCTP_MAX_SEND_AMOUNT.toString()}`
      );
    }
    const formatter = createFormatFunction(2, 4, false, TOKEN_SYMBOLS_MAP.USDC.decimals);
    const transaction = {
      contract: cctpMessenger,
      chainId: originChain,
      method: "depositForBurn",
      unpermissioned: false,
      nonMulticall: true,
      args: [
        amountToSend,
        getCctpDomainForChainId(destinationChain),
        this.baseSignerAddress.toBytes32(),
        originUsdcToken.toNative(),
        ethers.constants.HashZero, // Anyone can finalize the message on domain when this is set to bytes32(0)
        maxFee,
        finalityThreshold,
      ],
      message: `🎰 Bridged USDC via CCTP from ${getNetworkName(originChain)} to ${getNetworkName(destinationChain)}`,
      mrkdwn: `Bridged ${formatter(amountToBridge.toString())} USDC from ${getNetworkName(
        originChain
      )} to ${getNetworkName(destinationChain)} via CCTP`,
    };
    await this._submitTransaction(transaction);
  }

  private async _getCctpMessenger(chainId: number): Promise<Contract> {
    const cctpMessengerAddress = getCctpV2TokenMessenger(chainId);
    const originProvider = await getProvider(chainId);
    return new Contract(
      cctpMessengerAddress.address,
      cctpMessengerAddress.abi,
      this.baseSigner.connect(originProvider)
    );
  }

  private async _getOftMessenger(chainId: number): Promise<Contract> {
    const oftMessengerAddress = getMessengerEvm(
      EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]),
      chainId
    );
    const originProvider = await getProvider(chainId);
    return new Contract(oftMessengerAddress.toNative(), IOFT_ABI_FULL, this.baseSigner.connect(originProvider));
  }

  private async _getOftQuoteSend(
    originChain: number,
    destinationChain: number,
    amountToBridge: BigNumber
  ): Promise<{
    feeStruct: MessagingFeeStruct;
    sendParamStruct: SendParamStruct;
    oftMessenger: Contract;
  }> {
    const oftMessenger = await this._getOftMessenger(originChain);
    const sharedDecimals = await oftMessenger.sharedDecimals();

    const roundedAmount = roundAmountToSend(amountToBridge, TOKEN_SYMBOLS_MAP.USDT.decimals, sharedDecimals);
    const defaultFeePct = BigNumber.from(5 * 10 ** 15); // Default fee percent of 0.5%
    const appliedFee = isStargateBridge(destinationChain)
      ? roundedAmount.mul(defaultFeePct).div(fixedPointAdjustment) // Set a max slippage of 0.5%.
      : bnZero;
    const expectedOutputAmount = roundedAmount.sub(appliedFee);
    const destinationEid = getEndpointId(destinationChain);
    const sendParamStruct: SendParamStruct = {
      dstEid: destinationEid,
      to: formatToAddress(this.baseSignerAddress),
      amountLD: roundedAmount,
      // @dev Setting `minAmountLD` equal to `amountLD` ensures we won't hit contract-side rounding
      minAmountLD: expectedOutputAmount,
      extraOptions: "0x",
      composeMsg: "0x",
      oftCmd: "0x",
    };
    // Get the messaging fee for this transfer
    return {
      feeStruct: (await oftMessenger.quoteSend(sendParamStruct, false)) as MessagingFeeStruct,
      sendParamStruct: sendParamStruct,
      oftMessenger: oftMessenger,
    };
  }

  private async _sendOftBridge(
    originChain: number,
    destinationChain: number,
    amountToBridge: BigNumber
  ): Promise<void> {
    const { feeStruct, sendParamStruct, oftMessenger } = await this._getOftQuoteSend(
      originChain,
      destinationChain,
      amountToBridge
    );
    const nativeFeeCap = OFT_FEE_CAP_OVERRIDES[originChain] ?? OFT_DEFAULT_FEE_CAP;
    if (BigNumber.from(feeStruct.nativeFee).gt(nativeFeeCap)) {
      throw new Error(`Fee exceeds maximum allowed (${feeStruct.nativeFee} > ${nativeFeeCap})`);
    }
    const formatter = createFormatFunction(2, 4, false, TOKEN_SYMBOLS_MAP.USDT.decimals);
    // Set refund address to signer's address. This should technically never be required as all of our calcs
    // are precise, set it just in case
    const refundAddress = this.baseSignerAddress.toNative();
    const withdrawTxn = {
      contract: oftMessenger,
      chainId: originChain,
      method: "send",
      unpermissioned: false,
      nonMulticall: true,
      args: [sendParamStruct, feeStruct, refundAddress],
      value: BigNumber.from(feeStruct.nativeFee),
      message: `🎰 Withdrew USDT0 from ${getNetworkName(originChain)} to ${getNetworkName(destinationChain)} via OFT`,
      mrkdwn: `Withdrew ${formatter(amountToBridge.toString())} USDT0 from ${getNetworkName(
        originChain
      )} to ${getNetworkName(destinationChain)} via OFT`,
    };

    await this._submitTransaction(withdrawTxn);
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
      TOKEN_SYMBOLS_MAP[destinationToken].addresses[HYPEREVM],
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

  private async _getUnfinalizedOftBridgeAmount(originChain: number, destinationChain: number): Promise<BigNumber> {
    const originMessenger = await this._getOftMessenger(originChain);
    const destinationMessenger = await this._getOftMessenger(destinationChain);
    const originEventSearchConfig = await this._getEventSearchConfig(originChain);
    const destinationEventSearchConfig = await this._getEventSearchConfig(destinationChain);
    // Fetch OFT events to determine OFT send statuses.
    const [sent, received] = await Promise.all([
      paginatedEventQuery(
        originMessenger,
        // guid (Topic[1]) not filtered -> null, dstEid (non-indexed) -> undefined, fromAddress (Topic[3]) filtered
        originMessenger.filters.OFTSent(null, undefined, this.baseSignerAddress.toNative()),
        originEventSearchConfig
      ),
      paginatedEventQuery(
        destinationMessenger,
        // guid (Topic[1]) not filtered -> null, srcEid (non-indexed) -> undefined, toAddress (Topic[3]) filtered
        destinationMessenger.filters.OFTReceived(null, undefined, this.baseSignerAddress.toNative()),
        destinationEventSearchConfig
      ),
    ]);

    const dstEid = getEndpointId(destinationChain);
    const srcEid = getEndpointId(originChain);

    const bridgeInitiationEvents = sent.filter((event) => event.args.dstEid === dstEid);
    const bridgeFinalizationEvents = received.filter((event) => event.args.srcEid === srcEid);
    const finalizedGuids = new Set<string>(bridgeFinalizationEvents.map((event) => event.args.guid));

    // We want to make sure that amounts are denominated in destination chain decimals, in case origin and destination
    // tokens have different decimal precision:
    const amountConverter = this._getAmountConverter(
      originChain,
      EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[originChain]),
      destinationChain,
      EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[destinationChain])
    );
    let outstandingWithdrawalAmount = bnZero;
    for (const event of bridgeInitiationEvents) {
      if (!finalizedGuids.has(event.args.guid)) {
        outstandingWithdrawalAmount = outstandingWithdrawalAmount.add(amountConverter(event.args.amountReceivedLD));
      }
    }
    return outstandingWithdrawalAmount;
  }

  private async _getUnfinalizedCctpBridgeAmount(originChain: number, destinationChain: number): Promise<BigNumber> {
    const originMessenger = await this._getCctpMessenger(originChain);
    const destinationMessenger = await this._getCctpMessenger(destinationChain);
    const originEventSearchConfig = await this._getEventSearchConfig(originChain);
    const destinationEventSearchConfig = await this._getEventSearchConfig(destinationChain);
    // Fetch CCTP events to determine CCTP send statuses.
    const [sent, received] = await Promise.all([
      paginatedEventQuery(
        originMessenger,
        originMessenger.filters.DepositForBurn(
          TOKEN_SYMBOLS_MAP.USDC.addresses[originChain],
          undefined,
          this.baseSignerAddress.toNative()
        ),
        originEventSearchConfig
      ),
      // @dev: First parameter in MintAndWithdraw is mintRecipient, this should be the same as the fromAddress
      // for all use cases of this adapter.
      paginatedEventQuery(
        destinationMessenger,
        destinationMessenger.filters.MintAndWithdraw(
          this.baseSignerAddress.toNative(),
          undefined,
          TOKEN_SYMBOLS_MAP.USDC.addresses[destinationChain]
        ),
        destinationEventSearchConfig
      ),
    ]);
    const dstDomain = getCctpDomainForChainId(destinationChain);
    const bridgeInitiationEvents = sent.filter((event) => event.args.destinationDomain === dstDomain);

    const counted = new Set<number>();
    const withdrawalAmount = bridgeInitiationEvents.reduce((totalAmount, { args: sendArgs }) => {
      const matchingFinalizedEvent = received.find(({ args: receiveArgs }, idx) => {
        // Protect against double-counting the same l1 withdrawal events.
        const receivedAmount = toBN(receiveArgs.amount.toString()).add(toBN(receiveArgs.feeCollected.toString()));
        if (counted.has(idx) || !receivedAmount.eq(toBN(sendArgs.amount.toString()))) {
          return false;
        }

        counted.add(idx);
        return true;
      });
      return isDefined(matchingFinalizedEvent) ? totalAmount : totalAmount.add(sendArgs.amount);
    }, bnZero);
    return withdrawalAmount;
  }

  private _assertInitialized(): void {
    assert(this.initialized, "HyperliquidStablecoinSwapAdapter not initialized");
  }

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();
    const { HYPEREVM } = CHAIN_IDs;
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    // This function returns the total virtual balance of token that is in flight to chain.

    const allDestinationChains = this.availableRoutes.map((x) => x.destinationChain);

    // If there are any unfinalized bridges on the way to the destination chain, add virtual balances for them.
    for (const destinationChain of allDestinationChains) {
      pendingRebalances[destinationChain] ??= {};

      if (destinationChain !== HYPEREVM) {
        const usdtPendingRebalanceAmount = await this._getUnfinalizedOftBridgeAmount(HYPEREVM, destinationChain);
        if (usdtPendingRebalanceAmount.gt(bnZero)) {
          this.logger.debug({
            at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
            message: `Adding ${usdtPendingRebalanceAmount.toString()} for pending OFT rebalances from HyperEVM to ${destinationChain}`,
          });
          pendingRebalances[destinationChain]["USDT"] ??= usdtPendingRebalanceAmount;
        }

        const usdcPendingRebalanceAmount = await this._getUnfinalizedCctpBridgeAmount(HYPEREVM, destinationChain);
        if (usdcPendingRebalanceAmount.gt(bnZero)) {
          this.logger.debug({
            at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
            message: `Adding ${usdcPendingRebalanceAmount.toString()} for pending CCTP rebalances from HyperEVM to ${destinationChain}`,
          });
          pendingRebalances[destinationChain]["USDC"] ??= usdcPendingRebalanceAmount;
        }
      }
    }

    const pendingBridgeToHyperevm = await this._redisGetPendingBridgeToHyperevm();
    if (pendingBridgeToHyperevm.length > 0) {
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
        message: `Pending bridge to Hyperevm cloids: ${pendingBridgeToHyperevm.join(", ")}`,
      });
    }
    const allSourceChains = this.availableRoutes.map((x) => x.sourceChain);

    // If there are any finalized bridges to HyperEVM that correspond to orders that should subsequently be deposited
    // into Hypercore, we should subtract their virtual balance from HyperEVM.
    for (const sourceChain of allSourceChains) {
      pendingRebalances[sourceChain] ??= {};

      if (sourceChain !== HYPEREVM) {
        let usdtPendingRebalanceAmount = await this._getUnfinalizedOftBridgeAmount(sourceChain, HYPEREVM);
        let usdcPendingRebalanceAmount = await this._getUnfinalizedCctpBridgeAmount(sourceChain, HYPEREVM);

        for (const cloid of pendingBridgeToHyperevm) {
          const orderDetails = await this._redisGetOrderDetails(cloid);
          const { sourceToken, destinationToken, amountToTransfer } = orderDetails;
          if (orderDetails.sourceChain !== sourceChain) {
            continue;
          }

          const amountConverter = this._getAmountConverter(
            sourceChain,
            EvmAddress.from(TOKEN_SYMBOLS_MAP[sourceToken].addresses[sourceChain]),
            HYPEREVM,
            EvmAddress.from(TOKEN_SYMBOLS_MAP[destinationToken].addresses[HYPEREVM])
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
            message: `Subtracting ${convertedOrderAmount.toString()} for order cloid ${cloid} that has finalized`,
          });
          pendingRebalances[HYPEREVM][destinationToken] = (pendingRebalances[HYPEREVM][destinationToken] ?? bnZero).sub(
            convertedOrderAmount
          );
        }
        assert(
          usdtPendingRebalanceAmount.eq(bnZero) && usdcPendingRebalanceAmount.eq(bnZero),
          "Unfinalized bridge amount to HyperEVM should be 0 after evaluating all orders with status PENDING_BRIDGE_TO_HYPEREVM"
        );
      }
    }

    // For each pending withdrawal from Hypercore, check if it has finalized, and if it has, subtract its virtual balance from HyperEVM.
    pendingRebalances[HYPEREVM] ??= {};
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
        EvmAddress.from(TOKEN_SYMBOLS_MAP[sourceToken].addresses[sourceChain]),
        destinationChain,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[destinationToken].addresses[destinationChain])
      );
      const convertedAmount = amountConverter(amountToTransfer);
      this.logger.debug({
        at: "HyperliquidStablecoinSwapAdapter.getPendingRebalances",
        message: `Adding ${convertedAmount.toString()} for pending order cloid ${cloid}`,
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
