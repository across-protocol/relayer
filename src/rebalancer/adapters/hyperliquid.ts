import { RedisCache } from "../../caching/RedisCache";
import { AugmentedTransaction, MultiCallerClient, TransactionClient } from "../../clients";
import {
  Address,
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
  getTokenInfo,
  getV2DepositForBurnMaxFee,
  isDefined,
  isStargateBridge,
  MAX_SAFE_ALLOWANCE,
  MessagingFeeStruct,
  paginatedEventQuery,
  Provider,
  roundAmountToSend,
  SendParamStruct,
  Signer,
  toBN,
  toBNWei,
  TOKEN_SYMBOLS_MAP,
  winston,
} from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";
import * as hl from "@nktkas/hyperliquid";
import { RebalancerConfig } from "../RebalancerConfig";
import { CCTP_MAX_SEND_AMOUNT, IOFT_ABI_FULL, OFT_DEFAULT_FEE_CAP, OFT_FEE_CAP_OVERRIDES } from "../../common";

enum STATUS {
  PENDING_BRIDGE_TO_HYPEREVM,
  PENDING_SWAP,
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
export class HyperliquidStablecoinSwapAdapter implements RebalancerAdapter {
  private redisCache: RedisCache;

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

  private baseSignerAddress: EvmAddress;

  private lookbackSeconds = 60 * 60 * 24 * 7; // 7 days ago

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
      szDecimals: 2,
      pxDecimals: 5, // Max(5, 8 - szDecimals): https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
      isBuy: false,
    },
    "USDC-USDT": {
      index: 166,
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
  private transactionClient: TransactionClient;

  private providers: { [chainId: number]: Provider };

  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {
    // TODO
  }

  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    const { HYPEREVM } = CHAIN_IDs;
    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    const provider_999 = await getProvider(HYPEREVM);
    const connectedSigner_999 = this.baseSigner.connect(provider_999);
    this.redisCache = (await getRedisCache()) as RedisCache;
    this.availableRoutes = _availableRoutes;
    this.multicallerClient = new MultiCallerClient(this.logger, this.config.multiCallChunkSize, this.baseSigner);
    this.transactionClient = new TransactionClient(this.logger);

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
  }

  async initializeRebalance(rebalanceRoute: RebalanceRoute): Promise<void> {
    // If source token is not USDC, USDT, or USDH, throw.
    // If destination token is same as source token, throw.
    // If source token is USDH then throw if source chain is not HyperEVM.
    // If source chain is not HyperEVM, then initiate CCTP/OFT transfer to HyperEVM and save order
    //     with status PENDING_BRIDGE_TO_HYPEREVM. Save the transfer under BRIDGE_TO_HYPEREVM in order to correctly
    //     mark the order status.
    const cloid = await this._redisGetNextCloid();

    // When initializing a rebalance, the order status should be set either to PENDING_BRIDGE_TO_HYPEREVM or PENDING_DEPOSIT_TO_HYPERCORE
    // depending on the source chain.
    if (rebalanceRoute.sourceChain !== CHAIN_IDs.HYPEREVM) {
      // Bridge this token into HyperEVM first
      console.log(
        `Creating new order ${cloid} by first bridging ${rebalanceRoute.sourceToken} into HyperEVM from ${rebalanceRoute.sourceChain}`
      );

      // TODO: If depositing via CCTP, we can actually deposit directly into Hypercore and if so then we should progress
      // the status to PENDING_SWAP: https://developers.circle.com/cctp/transfer-usdc-from-ethereum-to-hypercore
      await this._bridgeToChain(
        rebalanceRoute.sourceToken,
        rebalanceRoute.sourceChain,
        CHAIN_IDs.HYPEREVM,
        rebalanceRoute.maxAmountToTransfer
      );
      await this._redisCreateOrder(cloid, STATUS.PENDING_BRIDGE_TO_HYPEREVM, rebalanceRoute);
    } else {
      console.log(`Creating new order ${cloid} by depositing ${rebalanceRoute.sourceToken} from HyperEVM to HyperCore`);

      await this._depositToHypercore(rebalanceRoute.sourceToken, rebalanceRoute.maxAmountToTransfer);
      await this._redisCreateOrder(cloid, STATUS.PENDING_DEPOSIT_TO_HYPERCORE, rebalanceRoute);
    }
  }

  private async _createHlOrder(rebalanceRoute: RebalanceRoute, cloid: string): Promise<void> {
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
    console.log(
      `Available balance ${balanceInputToken.total} is sufficient to place order with input size ${fromWei(
        rebalanceRoute.maxAmountToTransfer,
        tokenMeta.evmDecimals
      ).toString()} ${rebalanceRoute.sourceToken}`
    );

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

    console.log(`Placing order with cloid: ${cloid}`);
    await this._placeLimitOrder(cloid, rebalanceRoute, latestPrice);
  }

  private async _getEventSearchConfig(chainId: number): Promise<EventSearchConfig> {
    const fromTimestamp = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7; // 7 days ago
    const provider = await getProvider(chainId);
    const fromBlock = await getBlockForTimestamp(this.logger, chainId, fromTimestamp);
    const toBlock = await provider.getBlock("latest");
    const maxLookBack = this.config.maxBlockLookBack[chainId];
    return { from: fromBlock, to: toBlock.number, maxLookBack };
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

    // Figure out what time we last received an update so we can get all updates since then:
    const lastPollEnd = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7; // 7 days ago

    const infoClient = new hl.InfoClient({ transport: new hl.HttpTransport() });
    const openOrders = await infoClient.openOrders({ user: this.baseSignerAddress.toNative() });
    console.log("Open orders", openOrders);

    const pendingBridgeToHyperevm = await this._redisGetPendingBridgeToHyperevm();
    console.log("Orders pending bridge to HyperEVM", pendingBridgeToHyperevm);
    for (const cloid of pendingBridgeToHyperevm) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      // Check if we have enough balance on HyperEVM to progress the order status:
      const hyperevmBalance = await this._getBalance(
        CHAIN_IDs.HYPEREVM,
        TOKEN_SYMBOLS_MAP[orderDetails.destinationToken].addresses[CHAIN_IDs.HYPEREVM]
      );
      const amountConverter = this._getAmountConverter(
        orderDetails.sourceChain,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[orderDetails.sourceToken].addresses[orderDetails.sourceChain]),
        CHAIN_IDs.HYPEREVM,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[orderDetails.destinationToken].addresses[CHAIN_IDs.HYPEREVM])
      );
      const expectedAmountOnHyperevm = amountConverter(orderDetails.maxAmountToTransfer);
      if (hyperevmBalance.lt(expectedAmountOnHyperevm)) {
        console.log(
          `Not enough balance on HyperEVM to progress the order ${cloid} with status PENDING_BRIDGE_TO_HYPEREVM: ${expectedAmountOnHyperevm.toString()}`
        );
      } else {
        console.log("We have balance on HyperEVM to bridge into Hypercore, initiating a deposit now:");
        await this._depositToHypercore(orderDetails.sourceToken, expectedAmountOnHyperevm);
        await this._redisUpdateOrderStatus(
          cloid,
          STATUS.PENDING_BRIDGE_TO_HYPEREVM,
          STATUS.PENDING_DEPOSIT_TO_HYPERCORE
        );
      }

      // Otherwise, update the order status to pending bridge to Hypercore.
    }

    const pendingBridgeToHypercore = await this._redisGetPendingDepositsToHypercore();
    console.log("Orders pending deposit to Hypercore", pendingBridgeToHypercore);
    for (const cloid of pendingBridgeToHypercore) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      await this._createHlOrder(orderDetails, cloid);
      await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_DEPOSIT_TO_HYPERCORE, STATUS.PENDING_SWAP);
    }

    const pendingSwaps = await this._redisGetPendingSwaps();
    console.log("Orders pending swap", pendingSwaps);
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

    const pendingWithdrawals = await this._redisGetPendingWithdrawals();
    console.log("Orders pending withdrawal from Hypercore", pendingWithdrawals);
    for (const cloid of pendingWithdrawals) {
      // Check if we have enough balance on HyperEVM to cover the expected withdrawal amount, and if so, then either delete the order
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
      const hyperevmBalance = await this._getBalance(
        CHAIN_IDs.HYPEREVM,
        TOKEN_SYMBOLS_MAP[orderDetails.destinationToken].addresses[CHAIN_IDs.HYPEREVM]
      );
      if (hyperevmBalance.lt(expectedAmountToReceive)) {
        console.log(
          `Not enough balance on HyperEVM to cover the expected withdrawal amount: ${expectedAmountToReceive.toString()}`
        );
        return;
      }
      if (orderDetails.destinationChain === CHAIN_IDs.HYPEREVM) {
        console.log(`Deleting order details from Redis with cloid ${cloid} because it has completed!`);
      } else {
        console.log(
          `Sending order with cloid ${cloid} to final destination chain ${orderDetails.destinationChain}, and deleting order details from Redis!`
        );
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

    console.log("_getLatestPrice: latest price details from API:", tokenData);

    // Add 2bps to the mid price to increase probability of execution.
    // If direction is a Buy, we'll increase the price otherwise we'll decrease.
    // @dev: We add one to the toWei/fromWei precision because the midPx can have 1 more decimal than we are allowed
    // to use for pxDecimals, probably because midPx is the average of the best bid and ask px's.
    const midPricePlus = isBuy
      ? toBNWei(tokenData.midPx, spotMarketMeta.pxDecimals + 1)
          .mul(10002)
          .div(10000)
      : toBNWei(tokenData.midPx, spotMarketMeta.pxDecimals + 1)
          .mul(9998)
          .div(10000); // @dev prices can have up to 5 sig figs but mid price can have 6.

    // Price can have up to 5 significant figures so if the price is less than 1, then there can
    // be 5 decimal places. If the price starts with a 1, which is realistically the highest it will be for a
    // stablecoin swap, then there can be be 4 decimal places.
    console.log(`_getLatestPrice: midPricePlus: ${midPricePlus.toString()}`);
    const fullPrice = Number(fromWei(midPricePlus, spotMarketMeta.pxDecimals + 1));
    console.log(`_getLatestPrice: fullPrice: ${fullPrice} given midPricePlus: ${midPricePlus.toString()}`);
    return fullPrice.toFixed(fullPrice < 1 ? spotMarketMeta.pxDecimals : spotMarketMeta.pxDecimals - 1);
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

  private _getSzForOrder(rebalanceRoute: RebalanceRoute, px: string): { sz: number; minimumOrderSize: number } {
    const { sourceToken, destinationToken } = rebalanceRoute;
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
      ? rebalanceRoute.maxAmountToTransfer
          .mul(10 ** spotMarketMeta.pxDecimals)
          .div(toBNWei(px, spotMarketMeta.pxDecimals))
      : rebalanceRoute.maxAmountToTransfer;
    const destinationTokenMeta = this._getTokenMeta(destinationToken);
    const sourceTokenMeta = this._getTokenMeta(sourceToken);
    const evmDecimals = spotMarketMeta.isBuy ? destinationTokenMeta.evmDecimals : sourceTokenMeta.evmDecimals;
    const szFormatted = Number(fromWei(sz, evmDecimals)).toFixed(spotMarketMeta.szDecimals);
    return { sz: Number(szFormatted), minimumOrderSize: spotMarketMeta.minimumOrderSize };
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

    // Determining sz:
    // - The rebalanceRoute.amount is the amount of source tokens that are depositing into HL. It should already be
    // adjusted upwards to pay for any expected fees. However, sz is always specified in the base asset and px is
    // base / quote asset (px * sz returns a value denominated in the quote asset).
    // - Therefore, if isBuy is "true" then we are buying the "sz" amount of base asset with "rebalanceRoute.amount"
    // of the quote asset. We need to solve for "sz" and rebalance.amount = sz * px.
    // - If isBuy is "false" then we are selling "sz" amount of base asset to obtain the quote asset. The rebalanceRoute.amount
    // is denominated in the base asset, so rebalance.amount can be simply set to sz.
    const { sz, minimumOrderSize } = this._getSzForOrder(rebalanceRoute, px);
    console.log(
      `_placeLimitOrder: sz: ${sz} given price ${px} and isBuy ${
        spotMarketMeta.isBuy
      } and maxAmountToTransfer ${rebalanceRoute.maxAmountToTransfer.toString()}, minimumOrderSize ${minimumOrderSize}`
    );
    if (sz < minimumOrderSize) {
      throw new Error(`Order size ${sz.toString()} is less than minimum order size ${minimumOrderSize.toString()}`);
    }
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

  private async _submitTransaction(transaction: AugmentedTransaction): Promise<void> {
    const { reason, succeed, transaction: txnRequest } = (await this.transactionClient.simulate([transaction]))[0];
    const { contract: targetContract, method, ...txnRequestData } = txnRequest;
    if (!succeed) {
      const message = `Failed to simulate ${targetContract.address}.${method}(${txnRequestData.args.join(", ")}) on ${
        txnRequest.chainId
      }`;
      throw new Error(`${message} (${reason})`);
    }

    const response = await this.transactionClient.submit(transaction.chainId, [transaction]);
    if (response.length === 0) {
      throw new Error(
        `Transaction succeeded simulation but failed to submit onchain to ${
          targetContract.address
        }.${method}(${txnRequestData.args.join(", ")}) on ${txnRequest.chainId}`
      );
    }
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

    console.log(
      `_bridgeToChain: bridging ${token} from ${originChain} to ${destinationChain} for ${expectedAmountToTransfer.toString()}`
    );

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

  private async _sendOftBridge(
    originChain: number,
    destinationChain: number,
    amountToBridge: BigNumber
  ): Promise<void> {
    // TODO: In the future, this could re-use a OFTAdapter function.
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
    const feeStruct: MessagingFeeStruct = await oftMessenger.quoteSend(sendParamStruct, false);
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

  private async _getUnfinalizedOftBridgeAmount(originChain: number, destinationChain: number): Promise<BigNumber> {
    const originMessenger = await this._getOftMessenger(originChain);
    const destinationMessenger = await this._getOftMessenger(destinationChain);
    const originEventSearchConfig = await this._getEventSearchConfig(originChain);
    const destinationEventSearchConfig = await this._getEventSearchConfig(destinationChain);
    console.log(
      `Searching for OFT bridge events using event search configs: (chain: ${originChain}: ${JSON.stringify(
        originEventSearchConfig
      )}) and (chain: ${destinationChain}: ${JSON.stringify(destinationEventSearchConfig)})`
    );
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
    console.log(`Found ${bridgeInitiationEvents.length} OFT bridge initialization events`);
    console.log(`Found ${bridgeFinalizationEvents.length} OFT bridge finalization events`);
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
        console.log(
          `Found unfinalized OFT BridgeInitiated event for guid ${
            event.args.guid
          } with amount ${event.args.amountReceivedLD.toString()}`,
          event
        );
        outstandingWithdrawalAmount = outstandingWithdrawalAmount.add(amountConverter(event.args.amountReceivedLD));
      } else {
        console.log(`OFT bridge event with guid ${event.args.guid} is finalized!`, event);
      }
    }
    return outstandingWithdrawalAmount;
  }

  private async _getUnfinalizedCctpBridgeAmount(originChain: number, destinationChain: number): Promise<BigNumber> {
    const originMessenger = await this._getCctpMessenger(originChain);
    const destinationMessenger = await this._getCctpMessenger(destinationChain);
    const originEventSearchConfig = await this._getEventSearchConfig(originChain);
    const destinationEventSearchConfig = await this._getEventSearchConfig(destinationChain);
    console.log(
      `Searching for CCTP bridge events using event search configs: (chain: ${originChain}: ${JSON.stringify(
        originEventSearchConfig
      )}) and (chain: ${destinationChain}: ${JSON.stringify(destinationEventSearchConfig)})`
    );
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
    console.log(`Found ${sent.length} CCTP bridge initialization events from ${originChain} to ${destinationChain}`);
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

  async getPendingRebalances(rebalanceRoute: RebalanceRoute): Promise<{ [chainId: number]: BigNumber }> {
    const { sourceChain, sourceToken, destinationChain, destinationToken } = rebalanceRoute;
    const { HYPEREVM } = CHAIN_IDs;
    console.group(
      `getPendingRebalances for ${sourceChain} and ${sourceToken} to ${destinationChain} and ${destinationToken}`
    );
    const pendingRebalances: { [chainId: number]: BigNumber } = {};
    // This function returns the total virtual balance of token that is in flight to chain.

    // If there are any unfinalized bridges on the way to the destination chain, add virtual balances for them.
    if (destinationChain !== HYPEREVM) {
      let pendingRebalanceAmount = bnZero;
      if (destinationToken === "USDT") {
        pendingRebalanceAmount = await this._getUnfinalizedOftBridgeAmount(HYPEREVM, destinationChain);
        console.log(`- Adding ${pendingRebalanceAmount.toString()} for pending OFT rebalances from HyperEVM`);
      } else if (destinationToken === "USDC") {
        pendingRebalanceAmount = await this._getUnfinalizedCctpBridgeAmount(HYPEREVM, destinationChain);
        console.log(`- Adding ${pendingRebalanceAmount.toString()} for pending CCTP rebalances from HyperEVM`);
      } else {
        throw new Error(
          `Unimplemented token ${destinationToken} logical branch in getPendingRebalances() for bridges from HyperEVM`
        );
      }
      pendingRebalances[destinationChain] = pendingRebalanceAmount;
    }

    // If there are any finalized bridges to HyperEVM that correspond to orders that should subsequently be deposited
    // into Hypercore, we should subtract their virtual balance from HyperEVM.
    const pendingBridgeToHyperevm = await this._redisGetPendingBridgeToHyperevm();
    console.log(`- Pending bridge to Hypercore cloids: ${pendingBridgeToHyperevm.join(", ")}`);
    const [unfinalizedCctpBridgesToHyperevm, unfinalizedOftBridgesToHyperevm] = await Promise.all([
      this._getUnfinalizedCctpBridgeAmount(sourceChain, CHAIN_IDs.HYPEREVM),
      this._getUnfinalizedOftBridgeAmount(sourceChain, CHAIN_IDs.HYPEREVM),
    ]);

    // The algorithm here is a bit subtle. We can't easily associate pending OFT/CCTP rebalances with order cloids,
    // unless we saved the transaction hash down at the time of creating the cloid and initiating the bridge to
    // hyperevm. (If we did do that, then we'd need to keep track of pending rebalances and we'd have to
    // update them in the event queries above). The alternative implementation we use is to track the total
    // pending unfinalized amount, and subtract any order expected amounts from the pending amount. We can then
    // back into how many of these pending bridges to HyperEVM have finalized.
    let unfinalizedBridgeAmountToHyperevm = unfinalizedCctpBridgesToHyperevm.add(unfinalizedOftBridgesToHyperevm);
    console.log(`- Total unfinalized bridge amount to HyperEVM: ${unfinalizedBridgeAmountToHyperevm.toString()}`);
    // Convert maxAmountToTransfer to hyperevm chain precision:
    const amountConverter = this._getAmountConverter(
      sourceChain,
      EvmAddress.from(TOKEN_SYMBOLS_MAP[sourceToken].addresses[sourceChain]),
      HYPEREVM,
      EvmAddress.from(TOKEN_SYMBOLS_MAP[destinationToken].addresses[HYPEREVM])
    );
    for (const cloid of pendingBridgeToHyperevm) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      if (
        orderDetails.sourceChain !== sourceChain ||
        orderDetails.sourceToken !== sourceToken ||
        orderDetails.destinationChain !== destinationChain ||
        orderDetails.destinationToken !== destinationToken
      ) {
        continue;
      }

      // Check if this order is pending, if it is, then do nothing, but if it has finalized, then we need to subtract
      // its balance from HyperEVM.
      const convertedOrderAmount = amountConverter(orderDetails.maxAmountToTransfer);
      if (unfinalizedBridgeAmountToHyperevm.gt(convertedOrderAmount)) {
        console.log(
          `- Order cloid ${cloid} is possibly pending finalization to Hyperevm still (remaining pending amount: ${unfinalizedBridgeAmountToHyperevm.toString()}, order expected amount: ${convertedOrderAmount.toString()})`
        );
        unfinalizedBridgeAmountToHyperevm = unfinalizedBridgeAmountToHyperevm.sub(convertedOrderAmount);
        continue;
      }

      // Order has finalized, subtract virtual balance from HyperEVM:
      console.log(`- Subtracting ${convertedOrderAmount.toString()} for order cloid ${cloid} that has finalized`);
      const existingPendingRebalanceAmountDestinationChain = pendingRebalances[destinationChain] ?? bnZero;
      pendingRebalances[destinationChain] = existingPendingRebalanceAmountDestinationChain.sub(convertedOrderAmount);
    }

    // For any pending orders at all, we should add a virtual balance to the destination chain. This includes
    // orders with statuses: { PENDING_BRIDGE_TO_HYPEREVM, PENDING_SWAP, PENDING_DEPOSIT_TO_HYPERCORE, PENDING_WITHDRAWAL_FROM_HYPERCORE },
    const pendingSwaps = await this._redisGetPendingSwaps();
    const pendingWithdrawalsFromHypercore = await this._redisGetPendingWithdrawals();
    const pendingDepositsToHypercore = await this._redisGetPendingDepositsToHypercore();
    console.log(`- Pending swap cloids: ${pendingSwaps.join(", ")}`);
    console.log(`- Pending withdrawal from Hypercore cloids: ${pendingWithdrawalsFromHypercore.join(", ")}`);
    console.log(`- Pending deposit to Hypercore cloids: ${pendingDepositsToHypercore.join(", ")}`);
    const pendingCloids = new Set<string>(
      pendingSwaps.concat(pendingWithdrawalsFromHypercore).concat(pendingDepositsToHypercore)
    ).values();
    for (const cloid of pendingCloids) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      // Convert maxAmountToTransfer to destination chain precision:
      const amountConverter = this._getAmountConverter(
        orderDetails.sourceChain,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[orderDetails.sourceToken].addresses[orderDetails.sourceChain]),
        orderDetails.destinationChain,
        EvmAddress.from(TOKEN_SYMBOLS_MAP[orderDetails.destinationToken].addresses[orderDetails.destinationChain])
      );
      const convertedAmount = amountConverter(orderDetails.maxAmountToTransfer);
      console.log(`- Adding ${convertedAmount.toString()} for pending order cloid ${cloid} with status`);

      const existingPendingRebalanceAmountDestinationChain = pendingRebalances[destinationChain] ?? bnZero;
      pendingRebalances[destinationChain] = existingPendingRebalanceAmountDestinationChain.add(convertedAmount);
    }
    console.log("- Total pending rebalance amounts", pendingRebalances);
    console.groupEnd();
    return pendingRebalances;
  }

  private _getAmountConverter(
    originChain: number,
    originToken: Address,
    destinationChain: number,
    destinationToken: Address
  ): ReturnType<typeof ConvertDecimals> {
    const originTokenInfo = getTokenInfo(originToken, originChain);
    const destinationTokenInfo = getTokenInfo(destinationToken, destinationChain);
    return ConvertDecimals(originTokenInfo.decimals, destinationTokenInfo.decimals);
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

    // Create a new order in Redis. We use infinite expiry because we will delete this order after its no longer
    // used.
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
