import { BigNumber, Contract, Signer } from "ethers";
import { AugmentedTransaction } from "../../clients";
import {
  Address,
  EvmAddress,
  Provider,
  assert,
  createFormatFunction,
  ConvertDecimals,
  getNetworkName,
  getTranslatedTokenAddress,
  paginatedEventQuery,
  bnZero,
  EventSearchConfig,
  getTokenInfo,
} from "../../utils";
import { interfaces as sdkInterfaces } from "@across-protocol/sdk";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { IOFT_ABI_FULL, OFT_DEFAULT_FEE_CAP, OFT_FEE_CAP_OVERRIDES } from "../../common";
import * as OFT from "../../utils/OFTUtils";

export class OFTL2Bridge extends BaseL2BridgeAdapter {
  readonly l2Token: EvmAddress;
  private readonly l2ChainEid: number;
  private readonly l1ChainEid: number;
  private l2TokenInfo: sdkInterfaces.TokenInfo;
  private sharedDecimals?: number;
  private readonly nativeFeeCap: BigNumber;
  private l2ToL1AmountConverter: (amount: BigNumber) => BigNumber;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const translatedL2Token = getTranslatedTokenAddress(l1Token, hubChainId, l2chainId);
    assert(translatedL2Token.isEVM());
    this.l2Token = translatedL2Token;

    const l1OftMessenger = OFT.getMessengerEvm(l1Token, hubChainId);
    const l2OftMessenger = OFT.getMessengerEvm(l1Token, l2chainId);

    this.nativeFeeCap = OFT_FEE_CAP_OVERRIDES[this.l2chainId] ?? OFT_DEFAULT_FEE_CAP;

    this.l1Bridge = new Contract(l1OftMessenger.toNative(), IOFT_ABI_FULL, l1Provider);
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

    // We round `amount` to a specific precision to prevent rounding on the contract side. This way, we
    // receive the exact amount we sent in the transaction
    const roundedAmount = await this.roundAmountToSend(amount, this.l2TokenInfo.decimals);
    const sendParamStruct: OFT.SendParamStruct = {
      dstEid: this.l1ChainEid,
      to: OFT.formatToAddress(toAddress),
      amountLD: roundedAmount,
      // @dev Setting `minAmountLD` equal to `amountLD` ensures we won't hit contract-side rounding
      minAmountLD: roundedAmount,
      extraOptions: "0x",
      composeMsg: "0x",
      oftCmd: "0x",
    };

    // Get the messaging fee for this transfer
    const feeStruct: OFT.MessagingFeeStruct = await this.l2Bridge.quoteSend(sendParamStruct, false);
    if (BigNumber.from(feeStruct.nativeFee).gt(this.nativeFeeCap)) {
      throw new Error(`Fee exceeds maximum allowed (${feeStruct.nativeFee} > ${this.nativeFeeCap})`);
    }

    const formatter = createFormatFunction(2, 4, false, this.l2TokenInfo.decimals);
    // Set refund address to signer's address. This should technically never be required as all of our calcs
    // are precise, set it just in case
    const refundAddress = await this.l2Bridge.signer.getAddress();
    const withdrawTxn = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "send",
      unpermissionsed: false,
      nonMulticall: true,
      args: [sendParamStruct, feeStruct, refundAddress],
      value: BigNumber.from(feeStruct.nativeFee),
      message: `🎰 Withdrew ${this.l2Token} via OftL2Bridge to L1`,
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${this.l2TokenInfo.symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1 via OftL2Bridge`,
    };

    return [withdrawTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventSearchConfig: EventSearchConfig,
    l1EventSearchConfig: EventSearchConfig,
    fromAddress: Address,
    l2Token: Address
  ): Promise<BigNumber> {
    assert(l2Token.isEVM(), `Non-evm l2Token not supported: ${l2Token.toNative()}`);

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
        this.l2Bridge,
        // guid (Topic[1]) not filtered -> null, dstEid (non-indexed) -> undefined, fromAddress (Topic[3]) filtered
        this.l2Bridge.filters.OFTSent(null, undefined, fromAddress.toNative()),
        l2EventSearchConfig
      ),
      paginatedEventQuery(
        this.l1Bridge,
        // guid (Topic[1]) not filtered -> null, srcEid (non-indexed) -> undefined, toAddress (Topic[3]) filtered
        this.l1Bridge.filters.OFTReceived(null, undefined, l1RecipientAddress),
        l1EventSearchConfig
      ),
    ]);

    const l2BridgeInitiationEvents = l2SentAll.filter((event) => event.args.dstEid === this.l1ChainEid);
    const l1BridgeFinalizationEvents = l1ReceivedAll.filter((event) => event.args.srcEid === this.l2ChainEid);

    const finalizedGuids = new Set<string>(l1BridgeFinalizationEvents.map((event) => event.args.guid));

    let outstandingWithdrawalAmount = bnZero;
    for (const events of l2BridgeInitiationEvents) {
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

  /**
   * Rounds send amount so that dust doesn't get subtracted from it in the OFT contract.
   * @param amount amount to round
   * @returns amount rounded down
   */
  private async roundAmountToSend(amount: BigNumber, decimals: number): Promise<BigNumber> {
    // Fetch `sharedDecimals` if not already fetched
    this.sharedDecimals ??= await this.l2Bridge.sharedDecimals();

    return OFT.roundAmountToSend(amount, decimals, this.sharedDecimals);
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
        token: this.l2Token,
        bridge: EvmAddress.from(this.l2Bridge.address),
      },
    ];
  }
}
