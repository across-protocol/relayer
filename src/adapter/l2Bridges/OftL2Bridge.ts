import { EventSearchConfig } from "@across-protocol/sdk/dist/types/utils";
import { BigNumber, Contract, Signer } from "ethers";
import { AugmentedTransaction } from "../../clients";
import {
  Address,
  EvmAddress,
  Provider,
  assert,
  createFormatFunction,
  fetchTokenInfo,
  getNetworkName,
  getTranslatedTokenAddress,
  isDefined,
  paginatedEventQuery,
  isContractDeployedToAddress,
  bnZero,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import {
  CONTRACT_ADDRESSES,
  EVM_OFT_MESSENGERS,
  IOFT_ABI_FULL,
  OFT_DEFAULT_FEE_CAP,
  OFT_FEE_CAP_OVERRIDES,
} from "../../common";
import { OFT } from "../../utils/OFTUtils";

interface TokenInfo {
  symbol: string;
  decimals: number;
}

export class OftL2Bridge extends BaseL2BridgeAdapter {
  readonly l2Token: EvmAddress;
  private readonly l2ChainEid: number;
  private readonly l1ChainEid: number;
  private readonly l1HubPoolAddress: string;
  private l2TokenInfo?: TokenInfo;
  private sharedDecimals?: number;
  private readonly nativeFeeCap: BigNumber;

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

    const l1OftMessenger = EVM_OFT_MESSENGERS.get(l1Token.toNative())?.get(hubChainId);
    assert(isDefined(l1OftMessenger), `No OFT messenger configured for ${l1Token.toNative()} on chain ${hubChainId}`);

    const l2OftMessenger = EVM_OFT_MESSENGERS.get(l1Token.toNative())?.get(l2chainId);
    assert(isDefined(l2OftMessenger), `No OFT messenger configured for ${l1Token.toNative()} on chain ${l2chainId}`);

    this.nativeFeeCap = OFT_FEE_CAP_OVERRIDES[this.l2chainId] ?? OFT_DEFAULT_FEE_CAP;

    this.l1Bridge = new Contract(l1OftMessenger.toNative(), IOFT_ABI_FULL, l1Provider);
    this.l2Bridge = new Contract(l2OftMessenger.toNative(), IOFT_ABI_FULL, l2Signer);

    this.l2ChainEid = OFT.getEndpointId(l2chainId);
    this.l1ChainEid = OFT.getEndpointId(hubChainId);
    this.l1HubPoolAddress = CONTRACT_ADDRESSES[hubChainId]?.hubPool?.address;
    assert(isDefined(this.l1HubPoolAddress), `[OftL2Bridge] HubPool address not found for hubChainId ${hubChainId}`);
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
    this.l2TokenInfo ??= await fetchTokenInfo(this.l2Token.toNative(), this.l2Bridge.signer);
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
      message: `🎰 Withdrew ${this.l2Token.toNative()} via OftL2Bridge to L1`,
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

    assert(
      this.l2Token.eq(l2Token),
      `l2Token should equal this.l2Token. ${this.l2Token.toNative()} != ${l2Token.toNative()}`
    );

    // Determine the expected recipient on L1. If the initiator on L2 is a SpokePool,
    // then the recipient on L1 is the HubPool. Otherwise, it is the same EOA address.
    const isSpokePool = await isContractDeployedToAddress(fromAddress.toNative(), this.l2Bridge.provider);
    const l1RecipientAddress = isSpokePool ? this.l1HubPoolAddress : fromAddress.toNative();

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
        // todo: I believe that `amountReceivedLD` is in the local decimals of the sending chain
        // todo: do we need to convert to the decimals of the receiving chain here?
        outstandingWithdrawalAmount = outstandingWithdrawalAmount.add(events.args.amountReceivedLD);
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

  public override requiredTokenApprovals(): { token: EvmAddress; bridge: EvmAddress }[] {
    return [
      {
        token: this.l2Token,
        bridge: EvmAddress.from(this.l2Bridge.address),
      },
    ];
  }
}
