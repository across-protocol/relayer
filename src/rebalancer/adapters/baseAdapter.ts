import { RedisCache } from "../../caching/RedisCache";
import { AugmentedTransaction, TransactionClient } from "../../clients";
import { CCTP_MAX_SEND_AMOUNT, IOFT_ABI_FULL, OFT_DEFAULT_FEE_CAP, OFT_FEE_CAP_OVERRIDES } from "../../common";
import { TokenInfo } from "../../interfaces";
import {
  Address,
  BigNumber,
  bnZero,
  CHAIN_IDs,
  Contract,
  ConvertDecimals,
  createFormatFunction,
  ERC20,
  ethers,
  EvmAddress,
  fixedPointAdjustment,
  formatToAddress,
  getCctpDomainForChainId,
  getCctpV2TokenMessenger,
  getEndpointId,
  getMessengerEvm,
  getNetworkName,
  getProvider,
  getTokenInfo,
  getV2DepositForBurnMaxFee,
  isStargateBridge,
  MessagingFeeStruct,
  roundAmountToSend,
  SendParamStruct,
  Signer,
  TOKEN_EQUIVALENCE_REMAPPING,
  TOKEN_SYMBOLS_MAP,
  winston,
} from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";

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

  protected REDIS_PREFIX: string;
  protected REDIS_KEY_PENDING_ORDER: string;
  // Key used to query latest cloid that uniquely identifies orders. Also used to set cloids when placing HL orders.
  protected REDIS_KEY_LATEST_NONCE: string;

  // TODO: Add redis functions here:

  constructor(readonly logger: winston.Logger, readonly baseSigner: Signer) {
    this.transactionClient = new TransactionClient(logger);
  }

  async initialize(availableRoutes: RebalanceRoute[]): Promise<void> {
    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());

    // Make sure each source token and destination token has an entryin token symbols map:
    for (const route of availableRoutes) {
      const { sourceToken, destinationToken, sourceChain, destinationChain } = route;
      this._getTokenInfo(sourceToken, sourceChain);
      this._getTokenInfo(destinationToken, destinationChain);
    }
    this.initialized = true;
    return;
  }

  abstract initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void>;
  abstract updateRebalanceStatuses(): Promise<void>;
  abstract getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  abstract getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber>;

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

  protected async _bridgeToChain(
    token: string,
    originChain: number,
    destinationChain: number,
    expectedAmountToTransfer: BigNumber
  ): Promise<BigNumber> {
    if (destinationChain === originChain) {
      throw new Error("origin and destination chain are the same");
    }

    const balance = await this._getERC20Balance(originChain, this._getTokenInfo(token, originChain).address.toNative());
    if (balance.lt(expectedAmountToTransfer)) {
      throw new Error(
        `Not enough balance on ${originChain} to bridge ${token} to ${destinationChain} for ${expectedAmountToTransfer.toString()}`
      );
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

  private async _sendCctpBridge(
    originChain: number,
    destinationChain: number,
    amountToBridge: BigNumber
  ): Promise<BigNumber> {
    // TODO: In the future, this could re-use a CCTPAdapter function.
    const cctpMessenger = await this._getCctpMessenger(originChain);
    const originUsdcToken = this._getTokenInfo("USDC", originChain).address;
    // TODO: Don't always use fast mode, we should switch based on the expected fee and transfer size
    // incase a portion of the fee is fixed. The expected fee should be 1bp.
    const { maxFee, finalityThreshold } = await getV2DepositForBurnMaxFee(
      originUsdcToken,
      originChain,
      destinationChain,
      amountToBridge
    );
    if (amountToBridge.gt(CCTP_MAX_SEND_AMOUNT)) {
      // TODO: Handle this case by sending multiple transactions.
      throw new Error(
        `Amount to send ${amountToBridge.toString()} is greater than CCTP_MAX_SEND_AMOUNT ${CCTP_MAX_SEND_AMOUNT.toString()}`
      );
    }
    const formatter = createFormatFunction(2, 4, false, this._getTokenInfo("USDC", originChain).decimals);
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

  protected async _submitTransaction(transaction: AugmentedTransaction): Promise<void> {
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
}
