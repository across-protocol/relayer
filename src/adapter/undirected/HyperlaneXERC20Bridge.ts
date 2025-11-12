import {
  BigNumber,
  Contract,
  Signer,
  Provider,
  EvmAddress,
  assert,
  isDefined,
  ethers,
  paginatedEventQuery,
  Address,
  EventSearchConfig,
  winston,
} from "../../utils";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "../BaseBridgeAdapter";
import { processEvent } from "../utils";
import { PUBLIC_NETWORKS, HYPERLANE_NO_DOMAIN_ID } from "@across-protocol/constants";
import HYPERLANE_ROUTER_ABI from "../../common/abi/IHypXERC20Router.json";
import { HYPERLANE_DEFAULT_FEE_CAP, HYPERLANE_FEE_CAP_OVERRIDES, HYPERLANE_ROUTERS } from "../../common";

export class HyperlaneXERC20Bridge extends BaseBridgeAdapter<Signer, Signer | Provider> {
  readonly hubToken: EvmAddress;
  readonly dstToken: EvmAddress;
  private readonly hubDomainId: number;
  private readonly dstDomainId: number;

  constructor(
    dstChainId: number,
    srcChainId: number,
    srcSigner: Signer,
    dstSignerOrProvider: Signer | Provider,
    srcToken: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    const l1RouterAddressStr = HYPERLANE_ROUTERS[srcChainId]?.[srcToken.toNative()];
    assert(
      isDefined(l1RouterAddressStr),
      `No L1 Hyperlane router found for token ${srcToken.toNative()} on chain ${srcChainId}`
    );
    const l1RouterEvmAddress = EvmAddress.from(l1RouterAddressStr);

    super(dstChainId, srcChainId, srcSigner, dstSignerOrProvider, [l1RouterEvmAddress]);

    this.hubToken = srcToken;
    this.hubDomainId = PUBLIC_NETWORKS[srcChainId].hypDomainId;
    assert(
      this.hubDomainId != HYPERLANE_NO_DOMAIN_ID,
      `Hyperlane domain id not set for chain ${srcChainId}. Set it first before using HyperlaneXERC20Bridge`
    );
    this.dstDomainId = PUBLIC_NETWORKS[dstChainId].hypDomainId;
    assert(
      this.dstDomainId != HYPERLANE_NO_DOMAIN_ID,
      `Hyperlane domain id not set for chain ${dstChainId}. Set it first before using HyperlaneXERC20Bridge`
    );

    this.l1Bridge = new Contract(l1RouterAddressStr, HYPERLANE_ROUTER_ABI, srcSigner);

    const l2UnderlyingTokenAddressStr = this.resolveL2TokenAddress(srcToken);
    const l2RouterAddressStr = HYPERLANE_ROUTERS[dstChainId]?.[l2UnderlyingTokenAddressStr];
    assert(
      isDefined(l2RouterAddressStr),
      `No L2 Hyperlane router found for token ${l2UnderlyingTokenAddressStr} on chain ${dstChainId}`
    );

    this.dstToken = EvmAddress.from(l2UnderlyingTokenAddressStr);
    this.l2Bridge = new Contract(l2RouterAddressStr, HYPERLANE_ROUTER_ABI, dstSignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    srcToken: EvmAddress,
    _l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(
      this.hubToken.eq(srcToken),
      `this.srcToken does not match srcToken constructL1ToL2Txn was called with: ${this.hubToken} != ${srcToken}`
    );

    const fee: BigNumber = await this.l1Bridge.quoteGasPayment(this.dstDomainId);

    const feeCap = HYPERLANE_FEE_CAP_OVERRIDES[this.dstChainId] ?? HYPERLANE_DEFAULT_FEE_CAP;
    if (fee.gt(feeCap)) {
      throw new Error(
        `Hyperlane fee ${ethers.utils.formatEther(fee)} ETH exceeds cap ${ethers.utils.formatEther(
          feeCap
        )} ETH for chain ${this.dstChainId}`
      );
    }

    return {
      contract: this.l1Bridge,
      method: "transferRemote",
      args: [this.dstDomainId, toAddress.toBytes32(), amount],
      value: fee,
    };
  }

  /*
  Use cases:
  1. EOAs: all events will be returned for EOA with no surprises
  2. Hub + Spokes: all events will be returned for the Spoke
  */
  async queryL1BridgeInitiationEvents(
    srcToken: EvmAddress,
    _fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    if (!this.hubToken.eq(srcToken)) {
      return {};
    }

    const events = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.SentTransferRemote(this.dstDomainId, toAddress.toBytes32()),
      eventConfig
    );

    return {
      [this.dstToken.toNative()]: events.map((event) => {
        return processEvent(event, "amount");
      }),
    };
  }

  /*
  Use cases:
  1. EOAs: all events will be returned for EOA with no surprises
  2. Hub + Spokes: all events will be returned for the Spoke
  */
  async queryL2BridgeFinalizationEvents(
    srcToken: EvmAddress,
    _fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    if (!this.hubToken.eq(srcToken)) {
      return {};
    }

    const events = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.ReceivedTransferRemote(this.hubDomainId, toAddress.toBytes32()),
      eventConfig
    );

    return {
      [this.dstToken.toNative()]: events.map((event) => {
        return processEvent(event, "amount");
      }),
    };
  }
}
