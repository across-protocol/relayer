import { RebalanceRoute } from "../utils/interfaces";
import { BaseAdapter, STATUS } from "./baseAdapter";
import {
  bnZero,
  forEachAsync,
  BigNumber,
  assert,
  getProvider,
  TOKEN_SYMBOLS_MAP,
  CHAIN_IDs,
  Contract,
  ERC20,
  MAX_SAFE_ALLOWANCE,
  toBN,
  getMessengerEvm,
  EvmAddress,
  MessagingFeeStruct,
  SendParamStruct,
  roundAmountToSend,
  isStargateBridge,
  getEndpointId,
  fixedPointAdjustment,
  formatToAddress,
  createFormatFunction,
  getNetworkName,
  getLzTransactionDetails,
  getNativeTokenInfoForChain,
  toBNWei,
  ConvertDecimals,
} from "../../utils";
import { MultiCallerClient } from "../../clients";
import { EVM_OFT_MESSENGERS, IOFT_ABI_FULL, OFT_DEFAULT_FEE_CAP, OFT_FEE_CAP_OVERRIDES } from "../../common";
import { OFT_NO_EID, PRODUCTION_NETWORKS } from "@across-protocol/constants";
export class OftAdapter extends BaseAdapter {
  REDIS_PREFIX = "oft-bridge:";

  async initialize(availableRoutes: RebalanceRoute[]): Promise<void> {
    if (this.initialized) {
      return;
    }
    await super.initialize(availableRoutes.filter((route) => route.adapter === "oft"));

    await forEachAsync(this.availableRoutes, async (route) => {
      assert(
        PRODUCTION_NETWORKS[route.sourceChain].oftEid !== OFT_NO_EID &&
          EVM_OFT_MESSENGERS.get(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET])?.has(route.sourceChain) &&
          PRODUCTION_NETWORKS[route.destinationChain].oftEid !== OFT_NO_EID &&
          EVM_OFT_MESSENGERS.get(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET])?.has(route.destinationChain),
        `OFT bridge is not supported for route ${route.sourceChain} -> ${route.destinationChain}`
      );
    });
  }

  async setApprovals(): Promise<void> {
    this._assertInitialized();
    this.multicallerClient = new MultiCallerClient(this.logger, this.config.multiCallChunkSize, this.baseSigner);

    // Set Bridge allowances:
    const allChains = new Set<number>([...this.allSourceChains, ...this.allDestinationChains]);
    await forEachAsync(Array.from(allChains), async (chainId) => {
      const connectedSigner = this.baseSigner.connect(await getProvider(chainId));
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

    const simMode = !this.config.sendingTransactionsEnabled;
    await this.multicallerClient.executeTxnQueues(simMode);
  }

  async initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber> {
    this._assertInitialized();
    this._assertRouteIsSupported(rebalanceRoute);
    const txnHash = await this._sendOftBridge(
      rebalanceRoute.sourceChain,
      rebalanceRoute.destinationChain,
      amountToTransfer
    );
    // USDT0 transfers from HyperEVM take ~12 hours to finalize, so set a TTL of 24 hours to be safe.
    const ttlOverride =
      rebalanceRoute.sourceToken === "USDT" && rebalanceRoute.sourceChain === CHAIN_IDs.HYPEREVM
        ? 24 * 60 * 60
        : undefined;
    await this._redisCreateOrder(
      txnHash,
      STATUS.PENDING_BRIDGE_PRE_DEPOSIT,
      rebalanceRoute,
      amountToTransfer,
      ttlOverride
    );
    return amountToTransfer;
  }

  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();
    const pendingBridges = await this._redisGetPendingBridgesPreDeposit();
    if (pendingBridges.length > 0) {
      this.logger.debug({
        at: "OftAdapter.updateRebalanceStatuses",
        message: `Found ${pendingBridges.length} pending OFT bridges`,
        pendingBridges,
      });
    }
    for (const txnHash of pendingBridges) {
      const status = await this._getOftStatus(txnHash);
      if (status === "SUCCEEDED") {
        // Order is no longer pending, so we can delete it.
        this.logger.debug({
          at: "OftAdapter.updateRebalanceStatuses",
          message: `Order cloid ${txnHash} has been finalized`,
        });
        await this._redisDeleteOrder(txnHash, STATUS.PENDING_BRIDGE_PRE_DEPOSIT);
      }
    }
  }

  async sweepIntermediateBalances(): Promise<void> {
    // Does nothing.
    return;
  }

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();
    const timeSinceLastUpdate = Date.now() - this.lastUpdateTimestamp;
    // Within the same serverless run, we don't want this client to update more than once every 5 minutes.
    if (this.pendingRebalances && timeSinceLastUpdate < 5 * 60 * 1000) {
      this.logger.debug({
        at: "OftAdapter.getPendingRebalances",
        message: `Recently updated pending rebalances, returning cached pending rebalances (time since last update: ${timeSinceLastUpdate}ms)`,
      });
      return this.pendingRebalances;
    }
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

    const pendingBridges = await this._redisGetPendingBridgesPreDeposit();
    if (pendingBridges.length > 0) {
      this.logger.debug({
        at: "OftAdapter.getPendingRebalances",
        message: `Found ${pendingBridges.length} pending OFT bridges`,
        pendingBridges,
      });
    }
    for (const txnHash of pendingBridges) {
      const status = await this._getOftStatus(txnHash);
      if (status === "SUCCEEDED") {
        this.logger.debug({
          at: "OftAdapter.getPendingRebalances",
          message: `Order cloid ${txnHash} has already finalized, skipping incrementing pending rebalances`,
        });
        continue;
      }
      const pendingOrderDetails = await this._redisGetOrderDetails(txnHash);
      const { sourceChain, destinationChain, amountToTransfer } = pendingOrderDetails;
      // @dev Temporarily filter out L1->L2 and L2->L1 rebalances because they will already be counted by the
      // AdapterManager and this function is designed to be used in conjunction with the AdapterManager
      // to paint a full picture of all pending rebalances.
      if (sourceChain === this.config.hubPoolChainId || destinationChain === this.config.hubPoolChainId) {
        continue;
      }
      pendingRebalances[destinationChain] ??= {};
      pendingRebalances[destinationChain]["USDT"] = (pendingRebalances[destinationChain]?.["USDT"] ?? bnZero).add(
        amountToTransfer
      );
    }
    this.pendingRebalances = pendingRebalances;
    this.lastUpdateTimestamp = Date.now();
    return pendingRebalances;
  }

  async getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber> {
    this._assertRouteIsSupported(rebalanceRoute);
    const { sourceChain, destinationChain, sourceToken } = rebalanceRoute;
    const { feeStruct } = await this._getOftQuoteSend(sourceChain, destinationChain, amountToTransfer);
    // Convert native fee to USD and we assume that USD price is 1 and equivalent to the source/destination token.
    // This logic would need to change to support non stablecoin swaps.
    const nativeTokenInfo = getNativeTokenInfoForChain(sourceChain, CHAIN_IDs.MAINNET);
    const price = await this.priceClient.getPriceByAddress(nativeTokenInfo.address);
    const nativeFeeUsd = toBNWei(price.price).mul(feeStruct.nativeFee).div(toBNWei(1, nativeTokenInfo.decimals));
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);
    const nativeFeeSourceDecimals = ConvertDecimals(nativeTokenInfo.decimals, sourceTokenInfo.decimals)(nativeFeeUsd);
    return nativeFeeSourceDecimals;
  }

  async getPendingOrders(): Promise<string[]> {
    return this._redisGetPendingBridgesPreDeposit();
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
  ): Promise<string> {
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

    return await this._submitTransaction(withdrawTxn);
  }

  private async _getOftStatus(txnHash: string, retryNumber = 0): Promise<string> {
    if (retryNumber > 2) {
      throw new Error(`Failed to get OFT status for txnHash ${txnHash} after ${retryNumber} retries`);
    }
    try {
      const txnDetails = await getLzTransactionDetails(txnHash);
      assert(txnDetails.length === 1, "Expected 1 transaction details");
      return txnDetails[0].destination?.status;
    } catch (error) {
      // This API usually fails with a 4xx error if the origination event was just created so we should retry
      // after a short delay.
      await this._wait(10);
      return this._getOftStatus(txnHash, retryNumber + 1);
    }
  }
}
