import { CCTP_NO_DOMAIN, OFT_NO_EID, PRODUCTION_NETWORKS } from "@across-protocol/constants";
import { RedisCache } from "../../caching/RedisCache";
import { AugmentedTransaction, getAcrossHost, MultiCallerClient, TransactionClient } from "../../clients";
import {
  CCTP_MAX_SEND_AMOUNT,
  EVM_OFT_MESSENGERS,
  IOFT_ABI_FULL,
  OFT_DEFAULT_FEE_CAP,
  OFT_FEE_CAP_OVERRIDES,
} from "../../common";
import { TokenInfo } from "../../interfaces";
import {
  acrossApi,
  Address,
  assert,
  BigNumber,
  bnZero,
  CCTPV2_FINALITY_THRESHOLD_STANDARD,
  CHAIN_IDs,
  coingecko,
  Contract,
  ConvertDecimals,
  createFormatFunction,
  defiLlama,
  delay,
  ERC20,
  ethers,
  EventSearchConfig,
  EvmAddress,
  fixedPointAdjustment,
  forEachAsync,
  formatToAddress,
  getBlockForTimestamp,
  getCctpDomainForChainId,
  getCctpV2TokenMessenger,
  getEndpointId,
  getMessengerEvm,
  getNetworkName,
  getProvider,
  getRedisCache,
  getTokenInfo,
  isDefined,
  isStargateBridge,
  MAX_SAFE_ALLOWANCE,
  MessagingFeeStruct,
  paginatedEventQuery,
  PriceClient,
  roundAmountToSend,
  SendParamStruct,
  Signer,
  toBN,
  toBNWei,
  TOKEN_EQUIVALENCE_REMAPPING,
  TOKEN_SYMBOLS_MAP,
  winston,
} from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";
import { RebalancerConfig } from "../RebalancerConfig";
import { utils as sdkUtils } from "@across-protocol/sdk";

export interface OrderDetails {
  sourceToken: string;
  destinationToken: string;
  sourceChain: number;
  destinationChain: number;
  amountToTransfer: BigNumber;
}

export abstract class BaseAdapter implements RebalancerAdapter {
  protected transactionClient: TransactionClient;
  protected redisCache: RedisCache;
  protected baseSignerAddress: EvmAddress;
  protected initialized = false;
  protected priceClient: PriceClient;
  protected multicallerClient: MultiCallerClient;

  protected availableRoutes: RebalanceRoute[];
  protected allDestinationChains: Set<number>;
  protected allDestinationTokens: Set<string>;
  protected allSourceChains: Set<number>;
  protected allSourceTokens: Set<string>;

  protected REDIS_PREFIX: string;
  protected REDIS_KEY_PENDING_ORDER: string;
  // Key used to query latest cloid that uniquely identifies orders. This same cloid can be set when placing orders
  // on HL and Binance, thereby allowing us to track when an order gets filled and how much to withdraw subsequently.
  protected REDIS_KEY_LATEST_NONCE: string;

  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {
    this.transactionClient = new TransactionClient(logger);
    this.priceClient = new PriceClient(logger, [
      new acrossApi.PriceFeed({ host: getAcrossHost(CHAIN_IDs.MAINNET) }),
      new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
      new defiLlama.PriceFeed(),
    ]);
  }

  async initialize(availableRoutes: RebalanceRoute[]): Promise<void> {
    this.redisCache = (await getRedisCache(this.logger)) as RedisCache;

    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());

    // Make sure each source token and destination token has an entry in token symbols map:
    for (const route of availableRoutes) {
      const { sourceToken, destinationToken, sourceChain, destinationChain } = route;
      this._getTokenInfo(sourceToken, sourceChain);
      this._getTokenInfo(destinationToken, destinationChain);
    }

    this.availableRoutes = availableRoutes;
    this.allDestinationChains = new Set<number>(this.availableRoutes.map((x) => x.destinationChain));
    this.allDestinationTokens = new Set<string>(this.availableRoutes.map((x) => x.destinationToken));
    this.allSourceChains = new Set<number>(this.availableRoutes.map((x) => x.sourceChain));
    this.allSourceTokens = new Set<string>(this.availableRoutes.map((x) => x.sourceToken));

    this.multicallerClient = new MultiCallerClient(this.logger, this.config.multiCallChunkSize, this.baseSigner);

    // Set Bridge allowances:
    const allChains = new Set<number>([...this.allSourceChains, ...this.allDestinationChains]);
    await forEachAsync(Array.from(allChains), async (chainId) => {
      const connectedSigner = this.baseSigner.connect(await getProvider(chainId));
      if (getCctpV2TokenMessenger(chainId)?.address) {
        const usdc = new Contract(this._getTokenInfo("USDC", chainId).address.toNative(), ERC20.abi, connectedSigner);
        const cctpMessenger = await this._getCctpMessenger(chainId);
        const cctpAllowance = await usdc.allowance(this.baseSignerAddress.toNative(), cctpMessenger.address);
        if (cctpAllowance.lt(toBN(MAX_SAFE_ALLOWANCE).div(2))) {
          this.multicallerClient.enqueueTransaction({
            contract: usdc,
            chainId,
            method: "approve",
            nonMulticall: true,
            unpermissioned: false,
            args: [cctpMessenger.address, MAX_SAFE_ALLOWANCE],
            message: "Approved USDC for CCTP Messenger",
            mrkdwn: "Approved USDC for CCTP Messenger",
          });
        }
      }
      if (EVM_OFT_MESSENGERS.get(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET])?.has(chainId)) {
        const usdt = new Contract(this._getTokenInfo("USDT", chainId).address.toNative(), ERC20.abi, connectedSigner);
        const oftMessenger = await this._getOftMessenger(chainId);
        const oftAllowance = await usdt.allowance(this.baseSignerAddress.toNative(), oftMessenger.address);
        if (oftAllowance.lt(toBN(MAX_SAFE_ALLOWANCE).div(2))) {
          this.multicallerClient.enqueueTransaction({
            contract: usdt,
            chainId,
            method: "approve",
            nonMulticall: true,
            unpermissioned: false,
            args: [oftMessenger.address, MAX_SAFE_ALLOWANCE],
            message: "Approved USDT for OFT Messenger",
            mrkdwn: "Approved USDT for OFT Messenger",
          });
        }
      }
    });

    await this.multicallerClient.executeTxnQueues();
    this.initialized = true;
    return;
  }

  // ////////////////////////////////////////////////////////////
  // PUBLIC METHODS
  // ////////////////////////////////////////////////////////////

  abstract initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void>;
  abstract updateRebalanceStatuses(): Promise<void>;
  abstract getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  abstract getEstimatedCost(
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    debugLog: boolean
  ): Promise<BigNumber>;

  // ////////////////////////////////////////////////////////////
  // PROTECTED REDIS HELPER METHODS
  // ////////////////////////////////////////////////////////////

  protected abstract _redisGetOrderStatusKey(status: number): string;

  protected async _redisUpdateOrderStatus(cloid: string, oldStatus: number, status: number): Promise<void> {
    const oldOrderStatusKey = this._redisGetOrderStatusKey(oldStatus);
    const newOrderStatusKey = this._redisGetOrderStatusKey(status);
    const result = await Promise.all([
      this.redisCache.sRem(oldOrderStatusKey, cloid),
      this.redisCache.sAdd(newOrderStatusKey, cloid),
    ]);
    this.logger.debug({
      at: "BaseAdapter._redisUpdateOrderStatus",
      message: `Updated order status for cloid ${cloid} from ${oldOrderStatusKey} to ${newOrderStatusKey}`,
      result,
    });
  }

  protected async _redisCreateOrder(
    cloid: string,
    status: number,
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber
  ): Promise<void> {
    const orderStatusKey = this._redisGetOrderStatusKey(status);
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;

    // Create a new order in Redis. We use infinite expiry because we will delete this order after its no longer
    // used.
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;
    this.logger.debug({
      at: "BaseAdapter._redisCreateOrder",
      message: `Saving new order details for cloid ${cloid}`,
      orderStatusKey,
      orderDetailsKey,
      sourceToken,
      destinationToken,
      sourceChain,
      destinationChain,
      amountToTransfer: amountToTransfer.toString(),
    });

    const results = await Promise.all([
      this.redisCache.sAdd(orderStatusKey, cloid.toString()),
      this.redisCache.set(
        orderDetailsKey,
        JSON.stringify({
          sourceToken,
          destinationToken,
          sourceChain,
          destinationChain,
          amountToTransfer: amountToTransfer.toString(),
        }),
        Number.POSITIVE_INFINITY
      ),
    ]);
    this.logger.debug({
      at: "BaseAdapter._redisCreateOrder",
      message: `Completed saving new order details for cloid ${cloid}`,
      results,
    });
  }

  protected async _redisGetNextCloid(): Promise<string> {
    // Increment and get the latest nonce from Redis:
    const nonce = await this.redisCache.incr(`${this.REDIS_PREFIX}:${this.REDIS_KEY_LATEST_NONCE}`);

    return ethers.utils.hexZeroPad(ethers.utils.hexValue(nonce), 16);
  }

  protected async _redisGetOrderDetails(cloid: string): Promise<OrderDetails> {
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;
    const orderDetails = await this.redisCache.get<string>(orderDetailsKey);
    if (!orderDetails) {
      return undefined;
    }
    const rebalanceRoute = JSON.parse(orderDetails);
    return {
      ...rebalanceRoute,
      amountToTransfer: BigNumber.from(rebalanceRoute.amountToTransfer),
    };
  }

  protected async _redisDeleteOrder(cloid: string, currentStatus: number): Promise<void> {
    const orderStatusKey = this._redisGetOrderStatusKey(currentStatus);
    const orderDetailsKey = `${this.REDIS_KEY_PENDING_ORDER}:${cloid}`;
    const result = await Promise.all([
      this.redisCache.sRem(orderStatusKey, cloid),
      this.redisCache.del(orderDetailsKey),
    ]);
    this.logger.debug({
      at: "BaseAdapter._redisDeleteOrder",
      message: `Deleted order details for cloid ${cloid} under key ${orderDetailsKey} and from status set ${orderStatusKey}`,
      result,
    });
  }

  // ////////////////////////////////////////////////////////////
  // PROTECTED HELPER METHODS
  // ////////////////////////////////////////////////////////////

  protected _assertInitialized(): void {
    assert(this.initialized, "not initialized");
  }

  protected async _wait(seconds: number): Promise<void> {
    this.logger.debug({
      at: "BaseAdapter._wait",
      message: `Waiting for ${seconds} seconds...`,
    });
    await delay(seconds);
    return;
  }

  protected _getAmountConverter(
    originChain: number,
    originToken: Address,
    destinationChain: number,
    destinationToken: Address
  ): ReturnType<typeof ConvertDecimals> {
    const originTokenInfo = getTokenInfo(originToken, originChain);
    const destinationTokenInfo = getTokenInfo(destinationToken, destinationChain);
    return ConvertDecimals(originTokenInfo.decimals, destinationTokenInfo.decimals);
  }

  // SVM addresses currently unsupported
  protected _getTokenInfo(symbol: string, chainId: number): TokenInfo {
    const remappedTokenSymbols = Object.entries(TOKEN_EQUIVALENCE_REMAPPING)
      .filter(([, value]) => value === symbol)
      .map(([key]) => key);
    const allPossibleSymbols = [...remappedTokenSymbols, symbol];
    const tokenDetails = Object.values(TOKEN_SYMBOLS_MAP).find((details) => {
      const symbolMatches = allPossibleSymbols.some(
        (_symbol) => _symbol.toLowerCase() === details.symbol.toLowerCase()
      );
      if (!symbolMatches) {
        return false;
      }
      return details.addresses[chainId];
    });
    if (!tokenDetails) {
      throw new Error(
        `Token ${symbol} not found on chain ${chainId}, (remapped token symbols: ${remappedTokenSymbols.join(", ")})`
      );
    }
    return getTokenInfo(EvmAddress.from(tokenDetails.addresses[chainId]), chainId);
  }

  protected async _getERC20Balance(chainId: number, tokenAddress: string): Promise<BigNumber> {
    const provider = await getProvider(chainId);
    const connectedSigner = this.baseSigner.connect(provider);
    const erc20 = new Contract(tokenAddress, ERC20.abi, connectedSigner);
    const balance = await erc20.balanceOf(this.baseSignerAddress.toNative());
    return BigNumber.from(balance.toString());
  }

  /**
   * @notice Returns true if the the token on the chain can be bridged to another chain that can be used
   * for the adapter.
   * @param chainId
   * @param token
   * @returns Boolean indicating if the token can be bridged to another chain to be subsequently used by the adapter.
   */
  protected _chainIsBridgeable(chainId: number, token: string): boolean {
    if (token === "USDT") {
      return (
        PRODUCTION_NETWORKS[chainId].oftEid !== OFT_NO_EID &&
        EVM_OFT_MESSENGERS.get(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET])?.has(chainId)
      );
    } else if (token === "USDC") {
      return (
        PRODUCTION_NETWORKS[chainId].cctpDomain === CCTP_NO_DOMAIN ||
        !getCctpV2TokenMessenger(chainId)?.address !== undefined
      );
    } else {
      return false;
    }
  }

  protected async _bridgeToChain(
    token: string,
    originChain: number,
    destinationChain: number,
    expectedAmountToTransfer: BigNumber
  ): Promise<BigNumber> {
    if (destinationChain === originChain) {
      throw new Error("origin and destination chain are the same");
    }

    switch (token) {
      case "USDT":
        return await this._sendOftBridge(originChain, destinationChain, expectedAmountToTransfer);
      case "USDC":
        return await this._sendCctpBridge(originChain, destinationChain, expectedAmountToTransfer);
      default:
        throw new Error(`Should never happen: Unsupported bridge for token: ${token}`);
    }
  }

  private async _getCctpV2MaxFee(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    originChain: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    destinationChain: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amountToBridge: BigNumber
  ): Promise<{
    maxFee: BigNumber;
    finalityThreshold: number;
  }> {
    // @todo: Figure out how to switch to fast mode if the `maxFee` allows for it.
    return {
      maxFee: bnZero,
      finalityThreshold: CCTPV2_FINALITY_THRESHOLD_STANDARD,
    };
    // const { maxFee, finalityThreshold } = await getV2DepositForBurnMaxFee(
    //   this._getTokenInfo("USDC", originChain).address,
    //   originChain,
    //   destinationChain,
    //   amountToBridge,
    // );
    // return { maxFee, finalityThreshold };
  }

  private async _sendCctpBridge(
    originChain: number,
    destinationChain: number,
    amountToBridge: BigNumber
  ): Promise<BigNumber> {
    // TODO: In the future, this could re-use a CCTPAdapter function.
    const cctpMessenger = await this._getCctpMessenger(originChain);
    const originUsdcToken = this._getTokenInfo("USDC", originChain).address;
    if (amountToBridge.gt(CCTP_MAX_SEND_AMOUNT)) {
      // TODO: Handle this case by sending multiple transactions.
      throw new Error(
        `Amount to send ${amountToBridge.toString()} is greater than CCTP_MAX_SEND_AMOUNT ${CCTP_MAX_SEND_AMOUNT.toString()}`
      );
    }
    const formatter = createFormatFunction(2, 4, false, this._getTokenInfo("USDC", originChain).decimals);
    const { maxFee, finalityThreshold } = await this._getCctpV2MaxFee(originChain, destinationChain, amountToBridge);
    const transaction = {
      contract: cctpMessenger,
      chainId: originChain,
      method: "depositForBurn",
      unpermissioned: false,
      nonMulticall: true,
      args: [
        amountToBridge,
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
    // CCTP Fees are taken out of the source chain deposit so add them here so we end up with the desired input
    // amount on HyperEVM before depositing into Hypercore.
    return amountToBridge.sub(maxFee);
  }

  protected async _getCctpMessenger(chainId: number): Promise<Contract> {
    const cctpMessengerAddress = getCctpV2TokenMessenger(chainId);
    const originProvider = await getProvider(chainId);
    return new Contract(
      cctpMessengerAddress.address,
      cctpMessengerAddress.abi,
      this.baseSigner.connect(originProvider)
    );
  }

  protected async _getOftMessenger(chainId: number): Promise<Contract> {
    const oftMessengerAddress = getMessengerEvm(
      EvmAddress.from(this._getTokenInfo("USDT", CHAIN_IDs.MAINNET).address.toNative()),
      chainId
    );
    const originProvider = await getProvider(chainId);
    return new Contract(oftMessengerAddress.toNative(), IOFT_ABI_FULL, this.baseSigner.connect(originProvider));
  }

  protected async _getOftQuoteSend(
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

    const roundedAmount = roundAmountToSend(
      amountToBridge,
      this._getTokenInfo("USDT", originChain).decimals,
      sharedDecimals
    );
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
  ): Promise<BigNumber> {
    const { feeStruct, sendParamStruct, oftMessenger } = await this._getOftQuoteSend(
      originChain,
      destinationChain,
      amountToBridge
    );
    const nativeFeeCap = OFT_FEE_CAP_OVERRIDES[originChain] ?? OFT_DEFAULT_FEE_CAP;
    if (BigNumber.from(feeStruct.nativeFee).gt(nativeFeeCap)) {
      throw new Error(`Fee exceeds maximum allowed (${feeStruct.nativeFee} > ${nativeFeeCap})`);
    }
    const formatter = createFormatFunction(2, 4, false, this._getTokenInfo("USDT", originChain).decimals);
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
    return amountToBridge;
  }

  protected _getFromTimestamp(): number {
    return Math.floor(Date.now() / 1000) - 60 * 60 * 24; // 24 hours ago
  }

  protected async _getEventSearchConfig(chainId: number): Promise<EventSearchConfig> {
    const fromTimestamp = this._getFromTimestamp();
    const provider = await getProvider(chainId);
    const fromBlock = await getBlockForTimestamp(this.logger, chainId, fromTimestamp);
    const toBlock = await provider.getBlock("latest");
    const maxLookBack = this.config.maxBlockLookBack[chainId];
    return { from: fromBlock, to: toBlock.number, maxLookBack };
  }

  protected async _getBridgeFeePct(
    originChain: number,
    destinationChain: number,
    token: string,
    amountToTransfer: BigNumber
  ): Promise<BigNumber> {
    let bridgeFee = bnZero;
    if (token === "USDC") {
      // CCTP Fee:
      const { maxFee } = await this._getCctpV2MaxFee(originChain, destinationChain, amountToTransfer);
      bridgeFee = maxFee;
    } else if (token === "USDT") {
      // OFT Fee:
      const { feeStruct } = await this._getOftQuoteSend(originChain, destinationChain, amountToTransfer);
      // Convert native fee to USD and we assume that USD price is 1 and equivalent to the source/destination token.
      // This logic would need to change to support non stablecoin swaps.
      const nativeTokenSymbol = sdkUtils.getNativeTokenSymbol(originChain);
      const nativeTokenDecimals = this._getTokenInfo(nativeTokenSymbol, originChain).decimals;
      const nativeTokenAddresses = TOKEN_SYMBOLS_MAP[nativeTokenSymbol].addresses;
      const price = await this.priceClient.getPriceByAddress(
        nativeTokenAddresses[CHAIN_IDs.MAINNET] ?? nativeTokenAddresses[originChain]
      );
      const nativeFeeUsd = toBNWei(price.price).mul(feeStruct.nativeFee).div(toBNWei(1, nativeTokenDecimals));
      const sourceTokenInfo = this._getTokenInfo(token, originChain);
      const nativeFeeSourceDecimals = ConvertDecimals(nativeTokenDecimals, sourceTokenInfo.decimals)(nativeFeeUsd);
      bridgeFee = nativeFeeSourceDecimals;
    }
    return bridgeFee;
  }

  protected async _getUnfinalizedOftBridgeAmount(originChain: number, destinationChain: number): Promise<BigNumber> {
    if (
      !EVM_OFT_MESSENGERS.get(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET])?.has(originChain) ||
      !EVM_OFT_MESSENGERS.get(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET])?.has(destinationChain)
    ) {
      return bnZero;
    }
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
      this._getTokenInfo("USDT", originChain).address,
      destinationChain,
      this._getTokenInfo("USDT", destinationChain).address
    );
    let outstandingWithdrawalAmount = bnZero;
    for (const event of bridgeInitiationEvents) {
      if (!finalizedGuids.has(event.args.guid)) {
        outstandingWithdrawalAmount = outstandingWithdrawalAmount.add(amountConverter(event.args.amountReceivedLD));
      }
    }
    return outstandingWithdrawalAmount;
  }

  protected async _getUnfinalizedCctpBridgeAmount(originChain: number, destinationChain: number): Promise<BigNumber> {
    if (!getCctpV2TokenMessenger(originChain)?.address || !getCctpV2TokenMessenger(destinationChain)?.address) {
      return bnZero;
    }
    const originMessenger = await this._getCctpMessenger(originChain);
    const destinationMessenger = await this._getCctpMessenger(destinationChain);
    const originEventSearchConfig = await this._getEventSearchConfig(originChain);
    const destinationEventSearchConfig = await this._getEventSearchConfig(destinationChain);
    // Fetch CCTP events to determine CCTP send statuses.
    const [sent, received] = await Promise.all([
      paginatedEventQuery(
        originMessenger,
        originMessenger.filters.DepositForBurn(
          this._getTokenInfo("USDC", originChain).address.toNative(),
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
          this._getTokenInfo("USDC", destinationChain).address.toNative()
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

  protected async _submitTransaction(transaction: AugmentedTransaction): Promise<string> {
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
    return response[0].hash;
  }
}
