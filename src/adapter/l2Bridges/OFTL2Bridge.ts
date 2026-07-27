import { BigNumber, Contract, Signer } from "ethers";
import { AugmentedTransaction, getAcrossHost } from "../../clients";
import {
  Address,
  EvmAddress,
  assert,
  createFormatFunction,
  ConvertDecimals,
  getNetworkName,
  getNativeTokenInfoForChain,
  getTranslatedTokenAddress,
  paginatedEventQuery,
  bnZero,
  EventSearchConfig,
  getTokenInfo,
  fixedPointAdjustment,
  chainHasNativeToken,
  isDefined,
  stringifyThrownValue,
  toBNWei,
  winston,
  CHAIN_IDs,
  PriceClient,
  acrossApi,
  coingecko,
  defiLlama,
} from "../../utils";
import { interfaces as sdkInterfaces } from "@across-protocol/sdk";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import {
  IOFT_ABI_FULL,
  OFT_DEFAULT_FEE_CAP,
  OFT_FEE_CAP_OVERRIDES,
  OFT_MESSAGE_FEE_MAX_PCT,
  LZ_FEE_TOKENS,
} from "../../common";
import * as OFT from "../../utils/OFTUtils";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";
import { PendingBridgeAdapterName } from "../../rebalancer/clients/CctpOftReadOnlyClient";

export class OFTL2Bridge extends BaseL2BridgeAdapter {
  readonly l2Token: Address;
  private readonly l2ChainEid: number;
  private readonly l1ChainEid: number;
  private l2TokenInfo: sdkInterfaces.TokenInfo;
  private sharedDecimals?: number;
  private readonly nativeFeeCap: BigNumber;
  private l2ToL1AmountConverter: (amount: BigNumber) => BigNumber;
  private readonly feePct: BigNumber = BigNumber.from(5 * 10 ** 15); // Default fee percent of 0.5%
  private readonly minSendPctOfRequested: BigNumber;
  private priceClient?: PriceClient;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Signer: Signer,
    l1Token: EvmAddress,
    logger?: winston.Logger
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token, logger);
    this.minSendPctOfRequested = toBNWei(process.env.OFT_WITHDRAWAL_MIN_PCT_OF_REQUESTED ?? "0.2");

    const translatedL2Token = getTranslatedTokenAddress(l1Token, hubChainId, l2chainId);
    this.l2Token = translatedL2Token;

    const l1OftMessenger = OFT.getMessengerEvm(l1Token, hubChainId, l2chainId);
    const l2OftMessenger = OFT.getMessengerEvm(l1Token, l2chainId, l2chainId);

    this.nativeFeeCap = OFT_FEE_CAP_OVERRIDES[this.l2chainId] ?? OFT_DEFAULT_FEE_CAP;

    this.l1Bridge = new Contract(l1OftMessenger.toNative(), IOFT_ABI_FULL, l1Signer);
    this.l2Bridge = new Contract(l2OftMessenger.toNative(), IOFT_ABI_FULL, l2Signer);

    this.l2ChainEid = OFT.getEndpointId(l2chainId);
    this.l1ChainEid = OFT.getEndpointId(hubChainId);

    this.l2TokenInfo = getTokenInfo(this.l2Token, l2chainId);
    this.l2ToL1AmountConverter = this.createL2ToL1AmountConverter();
  }

  async constructWithdrawToL1Txns(
    toAddress: Address,
    l2Token: Address,
    l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    assert(
      this.l2Token.eq(l2Token),
      `this.l2Token does not match l2Token constructWithdrawToL1Txns was called with: ${this.l2Token} != ${l2Token}`
    );

    assert(
      toAddress.isEVM(),
      `OFTBridge only supports sending to EVM addresses. Dst address supplied ${toAddress.toNative()} is not EVM.`
    );

    const buildSendParams = (amountLD: BigNumber, minAmountLD: BigNumber): OFT.SendParamStruct => ({
      dstEid: this.l1ChainEid,
      to: OFT.formatToAddress(toAddress),
      amountLD,
      minAmountLD,
      extraOptions: "0x",
      composeMsg: "0x",
      oftCmd: "0x",
    });

    // We round `amount` to a specific precision to prevent rounding on the contract side. This way, we
    // receive the exact amount we sent in the transaction
    const requestedAmount = await this.roundAmountToSend(amount, this.l2TokenInfo.decimals);

    // Ask the bridge how much of the requested amount it can actually take right now. Stargate-style OFTs
    // cap the quoted `amountSentLD` at the path's available credit and revert on anything larger; vanilla
    // OFTs quote it equal to the requested amount. Quoted amounts are derived from shared decimals on the
    // contract side, so they need no re-rounding.
    const [oftLimit, , oftReceipt] = await this.getL2Bridge().quoteOFT(buildSendParams(requestedAmount, bnZero));
    const quotedSendAmount = BigNumber.from(oftReceipt.amountSentLD);
    const quotedReceiveAmount = BigNumber.from(oftReceipt.amountReceivedLD);
    const bridgeMinSendAmount = BigNumber.from(oftLimit.minAmountLD);
    const amountToSend = quotedSendAmount.lt(requestedAmount) ? quotedSendAmount : requestedAmount;

    // Stargate fees come out of `amountReceivedLD`; allow for at most `feePct` (0.5%) of them.
    const slippageAllowance = OFT.isStargateBridge(this.l2chainId)
      ? amountToSend.mul(this.feePct).div(fixedPointAdjustment)
      : bnZero;
    // @dev Requiring receipt of the send amount less the slippage allowance also ensures we won't hit
    // contract-side rounding.
    const minReceiveAmount = amountToSend.sub(slippageAllowance);

    // Skip the withdrawal instead of enqueueing a transaction that is guaranteed to revert; the excess is
    // retried on a later run.
    const bridgeHasNoCapacity = amountToSend.eq(bnZero) || amountToSend.lt(bridgeMinSendAmount);
    // Stargate fees can exceed the slippage allowance when path capacity is nearly drained.
    const feesExceedSlippageAllowance = quotedReceiveAmount.lt(minReceiveAmount);
    if (bridgeHasNoCapacity || feesExceedSlippageAllowance) {
      return [];
    }

    // A sized-down send far below the requested amount barely dents the excess while still paying full
    // per-message costs, so wait for the path to recover instead. Tunable via
    // OFT_WITHDRAWAL_MIN_PCT_OF_REQUESTED (fraction of the requested amount; default 0.2).
    const minAmountToSend = requestedAmount.mul(this.minSendPctOfRequested).div(fixedPointAdjustment);
    if (amountToSend.lt(minAmountToSend)) {
      this.logger?.warn({
        at: "OFTL2Bridge#constructWithdrawToL1Txns",
        message:
          "Skipping OFT withdrawal to hub chain: quoted bridge capacity is below the minimum percentage of the requested amount",
        chainId: this.l2chainId,
        l2Token: this.l2Token.toNative(),
        requestedAmount: requestedAmount.toString(),
        amountToSend: amountToSend.toString(),
        minSendPctOfRequested: this.minSendPctOfRequested.toString(),
      });
      return [];
    }

    const sendParamStruct = buildSendParams(amountToSend, minReceiveAmount);
    // Pay the bridge fee in the Lz token if the network does not have a native token (i.e. Tempo).
    const payFeeInLzToken = !chainHasNativeToken(this.l2chainId);

    // Get the messaging fee for this transfer
    const feeStruct: OFT.MessagingFeeStruct = await this.getL2Bridge().quoteSend(sendParamStruct, false);
    if (BigNumber.from(feeStruct.nativeFee).gt(this.nativeFeeCap)) {
      throw new Error(`Fee exceeds maximum allowed (${feeStruct.nativeFee} > ${this.nativeFeeCap})`);
    }

    // The message fee is roughly fixed per message regardless of size, so a capacity-constrained path
    // would otherwise be drained in dust-sized sends, each paying the full fee. Skip until the sendable
    // amount is worth enough that the fee stays below OFT_MESSAGE_FEE_MAX_PCT of it.
    if (await this.messageFeeExceedsMaxPct(BigNumber.from(feeStruct.nativeFee), amountToSend)) {
      return [];
    }

    const formatter = createFormatFunction(2, 4, false, this.l2TokenInfo.decimals);
    const sizedDownNote = amountToSend.lt(requestedAmount)
      ? ` (requested ${formatter(amount.toString())}, sized down to current bridge capacity)`
      : "";
    const approveTxn = payFeeInLzToken
      ? {
          contract: new Contract(LZ_FEE_TOKENS[this.l2chainId].toNative(), ERC20_ABI, this.l2Signer),
          chainId: this.l2chainId,
          method: "approve",
          unpermissionsed: false,
          nonMulticall: true,
          ensureConfirmation: true,
          args: [this.getL2Bridge().address, feeStruct.nativeFee],
          message: "🎰 Approved OftL2Bridge to spend LZ fee token.",
          mrkdwn: `Approved ${formatter(feeStruct.nativeFee.toString())} to ${this.getL2Bridge().address}`,
        }
      : undefined;

    // Set refund address to signer's address. This should technically never be required as all of our calcs
    // are precise, set it just in case
    const refundAddress = await this.getL2Bridge().signer.getAddress();
    const withdrawTxn = {
      contract: this.getL2Bridge(),
      chainId: this.l2chainId,
      method: "send",
      unpermissioned: false,
      nonMulticall: true,
      canFailInSimulation: payFeeInLzToken, // This can fail if the approval for the fee token is not set.
      args: [sendParamStruct, feeStruct, refundAddress],
      value: payFeeInLzToken ? bnZero : BigNumber.from(feeStruct.nativeFee),
      message: `🎰 Withdrew ${this.l2Token} via OftL2Bridge to L1`,
      mrkdwn:
        `Withdrew ${formatter(amountToSend.toString())} ${this.l2TokenInfo.symbol}${sizedDownNote} ` +
        `from ${getNetworkName(this.l2chainId)} to L1 via OftL2Bridge`,
    };

    return isDefined(approveTxn) ? [approveTxn, withdrawTxn] : [withdrawTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventSearchConfig: EventSearchConfig,
    l1EventSearchConfig: EventSearchConfig,
    fromAddress: Address,
    l2Token: Address
  ): Promise<BigNumber> {
    if (!this.l2Token.eq(l2Token)) {
      // Return 0 for tokens not associated with this OFTBridge
      // https://github.com/across-protocol/relayer/pull/2509#discussion_r2305205369
      return bnZero;
    }

    // Determine the expected recipient on L1. If the initiator on L2 is a SpokePool,
    // then the recipient on L1 is the HubPool. Otherwise, it is the same EOA address.
    const isAssociatedSpokePool = this.spokePoolAddress.eq(fromAddress);
    const l1RecipientAddress = isAssociatedSpokePool ? this.hubPoolAddress.toNative() : fromAddress.toNative();

    const [l2SentAll, l1ReceivedAll] = await Promise.all([
      paginatedEventQuery(
        this.getL2Bridge(),
        // guid (Topic[1]) not filtered -> null, dstEid (non-indexed) -> undefined, fromAddress (Topic[3]) filtered
        this.getL2Bridge().filters.OFTSent(null, undefined, fromAddress.toNative()),
        l2EventSearchConfig
      ),
      paginatedEventQuery(
        this.getL1Bridge(),
        // guid (Topic[1]) not filtered -> null, srcEid (non-indexed) -> undefined, toAddress (Topic[3]) filtered
        this.getL1Bridge().filters.OFTReceived(null, undefined, l1RecipientAddress),
        l1EventSearchConfig
      ),
    ]);

    const l2BridgeInitiationEvents = l2SentAll.filter((event) => event.args.dstEid === this.l1ChainEid);
    const l1BridgeFinalizationEvents = l1ReceivedAll.filter((event) => event.args.srcEid === this.l2ChainEid);
    const ignoredPendingBridgeTxnRefs = await this.getIgnoredPendingBridgeTxnRefs(
      this.l2chainId,
      this.hubChainId,
      fromAddress
    );

    const finalizedGuids = new Set<string>(l1BridgeFinalizationEvents.map((event) => event.args.guid));

    let outstandingWithdrawalAmount = bnZero;
    for (const events of l2BridgeInitiationEvents) {
      if (ignoredPendingBridgeTxnRefs.has(events.transactionHash)) {
        continue;
      }
      if (!finalizedGuids.has(events.args.guid)) {
        // Convert `amountReceivedLD` from event from LD (local decimals of the sending chain, which is the L2) into the
        // decimals of receiving chain (mainnet) to aggregate these amounts correctly upstream
        outstandingWithdrawalAmount = outstandingWithdrawalAmount.add(
          this.l2ToL1AmountConverter(events.args.amountReceivedLD)
        );
      }
    }

    return outstandingWithdrawalAmount;
  }

  public pendingWithdrawalLookbackPeriodSeconds(): number {
    if (this.l2chainId === CHAIN_IDs.HYPEREVM) {
      return 25 * 60 * 60; // USDT0 from HyperEVM is a special case taking ~24 hours to finalize.
    }
    return super.pendingWithdrawalLookbackPeriodSeconds();
  }
  /**
   * Rounds send amount so that dust doesn't get subtracted from it in the OFT contract.
   * @param amount amount to round
   * @param decimals token decimals to use for rounding
   * @returns amount rounded down
   */
  private async roundAmountToSend(amount: BigNumber, decimals: number): Promise<BigNumber> {
    // Fetch `sharedDecimals` if not already fetched
    const sharedDecimals = (this.sharedDecimals ??= await this.getL2Bridge().sharedDecimals());
    return OFT.roundAmountToSend(amount, decimals, sharedDecimals);
  }

  /**
   * Values the LayerZero message fee and the amount being bridged in USD and reports whether the fee
   * exceeds OFT_MESSAGE_FEE_MAX_PCT of the amount. Fails open when the check cannot be performed:
   * on chains without a native token the fee is paid in an LZ fee token with no reliable price feed,
   * and price lookups can transiently fail — in both cases the absolute `nativeFeeCap` still bounds
   * the fee.
   */
  private async messageFeeExceedsMaxPct(nativeFee: BigNumber, amountToSend: BigNumber): Promise<boolean> {
    const priceClient = this.getPriceClient();
    if (!isDefined(priceClient) || !chainHasNativeToken(this.l2chainId)) {
      return false;
    }
    try {
      const nativeToken = getNativeTokenInfoForChain(this.l2chainId, this.hubChainId);
      const [{ price: nativeTokenPrice }, { price: l1TokenPrice }] = await Promise.all([
        priceClient.getPriceByAddress(nativeToken.address),
        priceClient.getPriceByAddress(this.l1Token.toNative()),
      ]);
      const feeUsd = toBNWei(nativeTokenPrice).mul(nativeFee).div(toBNWei(1, nativeToken.decimals));
      const amountUsd = toBNWei(l1TokenPrice).mul(amountToSend).div(toBNWei(1, this.l2TokenInfo.decimals));
      const maxFeeUsd = amountUsd.mul(OFT_MESSAGE_FEE_MAX_PCT).div(fixedPointAdjustment);
      const feeExceedsMax = feeUsd.gt(maxFeeUsd);
      if (feeExceedsMax) {
        this.logger?.warn({
          at: "OFTL2Bridge#messageFeeExceedsMaxPct",
          message: "Skipping OFT withdrawal to hub chain: LZ message fee is disproportionate to the amount bridged",
          chainId: this.l2chainId,
          l2Token: this.l2Token.toNative(),
          amountToSend: amountToSend.toString(),
          amountUsd: amountUsd.toString(),
          nativeFee: nativeFee.toString(),
          feeUsd: feeUsd.toString(),
          maxFeePct: OFT_MESSAGE_FEE_MAX_PCT.toString(),
        });
      }
      return feeExceedsMax;
    } catch (e) {
      this.logger?.warn({
        at: "OFTL2Bridge#messageFeeExceedsMaxPct",
        message: "Failed to price OFT message fee; proceeding without the fee-vs-amount check",
        chainId: this.l2chainId,
        l2Token: this.l2Token.toNative(),
        error: stringifyThrownValue(e),
      });
      return false;
    }
  }

  private getPriceClient(): PriceClient | undefined {
    if (!isDefined(this.priceClient) && isDefined(this.logger)) {
      this.priceClient = new PriceClient(this.logger, [
        new acrossApi.PriceFeed({ host: getAcrossHost(this.hubChainId) }),
        new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
        new defiLlama.PriceFeed(),
      ]);
    }
    return this.priceClient;
  }

  /**
   * Returns a converter that maps an amount in L2 token local decimals (LD)
   * to the L1 token local decimals using ConvertDecimals. Created lazily and cached.
   */
  private createL2ToL1AmountConverter(): (amount: BigNumber) => BigNumber {
    const l1TokenInfo = getTokenInfo(this.l1Token, this.hubChainId);
    return ConvertDecimals(this.l2TokenInfo.decimals, l1TokenInfo.decimals);
  }

  public override requiredTokenApprovals(): { token: EvmAddress; bridge: EvmAddress }[] {
    return [
      {
        token: EvmAddress.from(this.l2Token.toEvmAddress()),
        bridge: EvmAddress.from(this.getL2Bridge().address),
      },
    ];
  }

  override getRebalancerPendingBridgeAdapterName(): PendingBridgeAdapterName {
    return "oft";
  }
}
