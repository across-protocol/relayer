import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  paginatedEventQuery,
  assert,
  EvmAddress,
  Address,
  winston,
  CHAIN_IDs,
  getTokenInfo,
} from "../../utils";
import { interfaces as sdkInterfaces } from "@across-protocol/sdk";
import { processEvent } from "../utils";
import * as OFT from "../../utils/OFTUtils";
import { OFT_DEFAULT_FEE_CAP, OFT_FEE_CAP_OVERRIDES } from "../../common/Constants";
import { IOFT_ABI_FULL } from "../../common/ContractAddresses";

export class OFTBridge extends BaseBridgeAdapter {
  public readonly l2TokenAddress: string;
  private readonly l1ChainEid: number;
  private readonly l2ChainEid: number;
  private l1TokenInfo: sdkInterfaces.TokenInfo;
  private sharedDecimals?: number;
  private readonly nativeFeeCap: BigNumber;

  constructor(
    l2ChainId: number,
    l1ChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    public readonly l1TokenAddress: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    // OFT bridge currently only supports Ethereum MAINNET as hub chain
    assert(
      l1ChainId == CHAIN_IDs.MAINNET,
      `OFT bridge only supports Ethereum as hub chain, got chain ID: ${l1ChainId}`
    );

    // Route discovery via configured IOFT messengers: if both L1 and L2 messengers exist, the route exists
    const l1OftMessenger = OFT.getMessengerEvm(l1TokenAddress, l1ChainId);
    const l2OftMessenger = OFT.getMessengerEvm(l1TokenAddress, l2ChainId);

    super(l2ChainId, l1ChainId, l1Signer, [l1OftMessenger]);

    this.l2TokenAddress = this.resolveL2TokenAddress(l1TokenAddress);
    this.l1ChainEid = OFT.getEndpointId(l1ChainId);
    this.l2ChainEid = OFT.getEndpointId(l2ChainId);
    this.l1Bridge = new Contract(l1OftMessenger.toNative(), IOFT_ABI_FULL, l1Signer);
    this.l2Bridge = new Contract(l2OftMessenger.toNative(), IOFT_ABI_FULL, l2SignerOrProvider);
    this.nativeFeeCap = OFT_FEE_CAP_OVERRIDES[this.hubChainId] ?? OFT_DEFAULT_FEE_CAP;
    this.l1TokenInfo = getTokenInfo(this.l1TokenAddress, this.hubChainId);
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    _l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // Verify the token matches the one this bridge was constructed for
    assert(
      l1Token.eq(this.l1TokenAddress),
      `This bridge instance only supports token ${this.l1TokenAddress}, not ${l1Token}`
    );

    assert(
      toAddress.isEVM(),
      `OFTBridge only supports sending to EVM addresses. Dst address supplied ${toAddress.toNative()} is not EVM.`
    );

    // We round `amount` to a specific precision to prevent rounding on the contract side. This way, we
    // receive the exact amount we sent in the transaction
    const roundedAmount = await this.roundAmountToSend(amount);
    const sendParamStruct: OFT.SendParamStruct = {
      dstEid: this.l2ChainEid,
      to: OFT.formatToAddress(toAddress),
      amountLD: roundedAmount,
      // @dev Setting `minAmountLD` equal to `amountLD` ensures we won't hit contract-side rounding
      minAmountLD: roundedAmount,
      extraOptions: "0x",
      composeMsg: "0x",
      oftCmd: "0x",
    };

    // Get the messaging fee for this transfer
    const feeStruct: OFT.MessagingFeeStruct = await this.getL1Bridge().quoteSend(sendParamStruct, false);
    if (BigNumber.from(feeStruct.nativeFee).gt(this.nativeFeeCap)) {
      throw new Error(`Fee exceeds maximum allowed (${feeStruct.nativeFee} > ${this.nativeFeeCap})`);
    }

    // Set refund address to signer's address. This should technically never be required as all of our calcs
    // are precise, set it just in case
    const refundAddress = await this.l1Bridge.signer.getAddress();
    return {
      contract: this.l1Bridge,
      method: "send",
      args: [sendParamStruct, feeStruct, refundAddress],
      value: BigNumber.from(feeStruct.nativeFee),
    };
  }

  /**
   * Rounds send amount so that dust doesn't get subtracted from it in the OFT contract.
   * @param amount amount to round
   * @returns amount rounded down
   */
  private async roundAmountToSend(amount: BigNumber): Promise<BigNumber> {
    // Fetch `sharedDecimals` if not already fetched
    this.sharedDecimals ??= await this.l1Bridge.sharedDecimals();

    return OFT.roundAmountToSend(amount, this.l1TokenInfo.decimals, this.sharedDecimals);
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Return no events if the query is for a different l1 token
    if (!l1Token.eq(this.l1TokenAddress)) {
      return {};
    }

    // Return no events if the query is for hubPool
    if (fromAddress.eq(this.hubPoolAddress)) {
      return {};
    }

    const isAssociatedSpokePool = this.spokePoolAddress.eq(toAddress);
    const fromHubEvents = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.OFTSent(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // dstEid - not an indexed parameter, must be `undefined`
        // If the request is for a spoke pool, return `OFTSent` events from hubPool
        isAssociatedSpokePool ? this.hubPoolAddress.toNative() : fromAddress.toNative()
      ),
      eventConfig
    );

    // Filter events by destination eid. This gives us [hubPool -> dst_chain] events, which are [hubPool -> dst_spoke] events we were looking for
    const events = fromHubEvents.filter(({ args }) => args.dstEid === this.l2ChainEid);

    return {
      [this.l2TokenAddress]: events.map((event) => {
        return processEvent(event, "amountReceivedLD");
      }),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Return no events if the query is for a different l1 token
    if (!l1Token.eq(this.l1TokenAddress)) {
      return {};
    }

    // Return no events if the query is for hubPool
    if (fromAddress.eq(this.hubPoolAddress)) {
      return {};
    }

    // Get `OFTReceived` events for [hub chain -> toAddress]
    const allEvents = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.OFTReceived(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // srcEid - not an indexed parameter, should be undefined
        toAddress.toNative() // filter by `toAddress`
      ),
      eventConfig
    );

    // Filter events by source eid
    const events = allEvents.filter((event) => event.args.srcEid === this.l1ChainEid);

    return {
      [this.l2TokenAddress]: events.map((event) => {
        return processEvent(event, "amountReceivedLD");
      }),
    };
  }
}
