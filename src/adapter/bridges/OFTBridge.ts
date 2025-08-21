import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  fetchTokenInfo,
  isDefined,
  paginatedEventQuery,
  assert,
  EvmAddress,
  Address,
  isContractDeployedToAddress,
  winston,
} from "../../utils";
import { processEvent } from "../utils";
import { CHAIN_IDs } from "@across-protocol/constants";
import {
  CONTRACT_ADDRESSES,
  IOFT_ABI_FULL,
  EVM_OFT_MESSENGERS,
  OFT_DEFAULT_FEE_CAP,
  OFT_FEE_CAP_OVERRIDES,
} from "../../common";
import { OFT } from "../../utils/OFTUtils";

export class OFTBridge extends BaseBridgeAdapter {
  private readonly hubPoolAddress: string;
  public readonly dstTokenAddress: string;
  private readonly dstChainEid: number;
  private tokenDecimals?: number;
  private sharedDecimals?: number;
  private readonly nativeFeeCap: BigNumber;

  constructor(
    dstChainId: number,
    hubChainId: number,
    hubSigner: Signer,
    dstSignerOrProvider: Signer | Provider,
    public readonly hubTokenAddress: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    // OFT bridge currently only supports Ethereum MAINNET as hub chain
    assert(
      hubChainId == CHAIN_IDs.MAINNET,
      `OFT bridge only supports Ethereum as hub chain, got chain ID: ${hubChainId}`
    );

    // Route discovery via configured IOFT messengers: if both hub and dst messengers exist, the route exists
    const l1OftMessenger = EVM_OFT_MESSENGERS.get(hubTokenAddress.toNative())?.get(hubChainId);
    assert(
      isDefined(l1OftMessenger),
      `No OFT messenger configured for ${hubTokenAddress.toNative()} on chain ${hubChainId}`
    );

    const l2OftMessenger = EVM_OFT_MESSENGERS.get(hubTokenAddress.toNative())?.get(dstChainId);
    assert(
      isDefined(l2OftMessenger),
      `No OFT messenger configured for ${hubTokenAddress.toNative()} on chain ${dstChainId}`
    );

    super(dstChainId, hubChainId, hubSigner, [l1OftMessenger]);

    this.hubPoolAddress = CONTRACT_ADDRESSES[hubChainId]?.hubPool?.address;
    assert(isDefined(this.hubPoolAddress), `Hub pool address not found for chain ${hubChainId}`);
    this.dstTokenAddress = this.resolveL2TokenAddress(hubTokenAddress);
    this.dstChainEid = OFT.getEndpointId(dstChainId);
    this.l1Bridge = new Contract(l1OftMessenger.toNative(), IOFT_ABI_FULL, hubSigner);
    this.l2Bridge = new Contract(l2OftMessenger.toNative(), IOFT_ABI_FULL, dstSignerOrProvider);
    this.nativeFeeCap = OFT_FEE_CAP_OVERRIDES[this.hubChainId] ?? OFT_DEFAULT_FEE_CAP;
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    _l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // Verify the token matches the one this bridge was constructed for
    assert(
      l1Token.eq(this.hubTokenAddress),
      `This bridge instance only supports token ${this.hubTokenAddress.toNative()}, not ${l1Token.toNative()}`
    );

    assert(
      toAddress.isEVM(),
      `OFTBridge only supports sending to EVM addresses. Dst address supplied ${toAddress.toNative()} is not EVM.`
    );

    // We round `amount` to a specific precision to prevent rounding on the contract side. This way, we
    // receive the exact amount we sent in the transaction
    const roundedAmount = await this.roundAmountToSend(amount);
    const sendParamStruct: OFT.SendParamStruct = {
      dstEid: this.dstChainEid,
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
    // Same for `tokenDecimals`
    this.tokenDecimals ??= (await fetchTokenInfo(this.hubTokenAddress.toNative(), this.l1Bridge.signer)).decimals;

    return OFT.roundAmountToSend(amount, this.tokenDecimals, this.sharedDecimals);
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Return no events if the query is for a different l1 token
    if (!l1Token.eq(this.hubTokenAddress)) {
      return {};
    }

    // Return no events if the query is for hubPool
    if (fromAddress.eq(EvmAddress.from(this.hubPoolAddress))) {
      return {};
    }

    const isSpokePool = await isContractDeployedToAddress(toAddress.toNative(), this.l2Bridge.provider);
    const fromHubEvents = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.OFTSent(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // dstEid - not an indexed parameter, must be `undefined`
        // If the request is for a spoke pool, return `OFTSent` events from hubPool
        isSpokePool ? this.hubPoolAddress : fromAddress.toNative()
      ),
      eventConfig
    );

    // Filter events by destination eid. This gives us [hubPool -> dst_chain] events, which are [hubPool -> dst_spoke] events we were looking for
    const events = fromHubEvents.filter(({ args }) => args.dstEid === this.dstChainEid);

    return {
      [this.dstTokenAddress]: events.map((event) => {
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
    if (!l1Token.eq(this.hubTokenAddress)) {
      return {};
    }

    // Return no events if the query is for hubPool
    if (fromAddress.eq(EvmAddress.from(this.hubPoolAddress))) {
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
    const sourceEid = OFT.getEndpointId(this.hubChainId);
    const events = allEvents.filter((event) => event.args.srcEid === sourceEid);

    return {
      [this.dstTokenAddress]: events.map((event) => {
        return processEvent(event, "amountReceivedLD");
      }),
    };
  }
}
