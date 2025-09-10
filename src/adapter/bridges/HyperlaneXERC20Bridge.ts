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
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";
import { PUBLIC_NETWORKS, HYPERLANE_NO_DOMAIN_ID } from "@across-protocol/constants";
import HYPERLANE_ROUTER_ABI from "../../common/abi/IHypXERC20Router.json";
import { HYPERLANE_DEFAULT_FEE_CAP, HYPERLANE_FEE_CAP_OVERRIDES, HYPERLANE_ROUTERS } from "../../common";

export class HyperlaneXERC20Bridge extends BaseBridgeAdapter {
  readonly hubToken: EvmAddress;
  readonly dstToken: EvmAddress;
  private readonly hubDomainId: number;
  private readonly dstDomainId: number;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    const l1RouterAddressStr = HYPERLANE_ROUTERS[hubChainId]?.[l1Token.toNative()];
    assert(
      isDefined(l1RouterAddressStr),
      `No L1 Hyperlane router found for token ${l1Token.toNative()} on chain ${hubChainId}`
    );
    const l1RouterEvmAddress = EvmAddress.from(l1RouterAddressStr);

    super(l2chainId, hubChainId, l1Signer, [l1RouterEvmAddress]);

    this.hubToken = l1Token;
    this.hubDomainId = PUBLIC_NETWORKS[hubChainId].hypDomainId;
    assert(
      this.hubDomainId != HYPERLANE_NO_DOMAIN_ID,
      `Hyperlane domain id not set for chain ${hubChainId}. Set it first before using HyperlaneXERC20Bridge`
    );
    this.dstDomainId = PUBLIC_NETWORKS[l2chainId].hypDomainId;
    assert(
      this.dstDomainId != HYPERLANE_NO_DOMAIN_ID,
      `Hyperlane domain id not set for chain ${l2chainId}. Set it first before using HyperlaneXERC20Bridge`
    );

    this.l1Bridge = new Contract(l1RouterAddressStr, HYPERLANE_ROUTER_ABI, l1Signer);

    const l2UnderlyingTokenAddressStr = this.resolveL2TokenAddress(l1Token);
    const l2RouterAddressStr = HYPERLANE_ROUTERS[l2chainId]?.[l2UnderlyingTokenAddressStr];
    assert(
      isDefined(l2RouterAddressStr),
      `No L2 Hyperlane router found for token ${l2UnderlyingTokenAddressStr} on chain ${l2chainId}`
    );

    this.dstToken = EvmAddress.from(l2UnderlyingTokenAddressStr);
    this.l2Bridge = new Contract(l2RouterAddressStr, HYPERLANE_ROUTER_ABI, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    _l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(
      this.hubToken.eq(l1Token),
      `this.l1Token does not match l1Token constructL1ToL2Txn was called with: ${this.hubToken} != ${l1Token}`
    );

    const fee: BigNumber = await this.l1Bridge.quoteGasPayment(this.dstDomainId);

    const feeCap = HYPERLANE_FEE_CAP_OVERRIDES[this.l2chainId] ?? HYPERLANE_DEFAULT_FEE_CAP;
    if (fee.gt(feeCap)) {
      throw new Error(
        `Hyperlane fee ${ethers.utils.formatEther(fee)} ETH exceeds cap ${ethers.utils.formatEther(
          feeCap
        )} ETH for chain ${this.l2chainId}`
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
    l1Token: EvmAddress,
    _fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    if (!this.hubToken.eq(l1Token)) {
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
    l1Token: EvmAddress,
    _fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    if (!this.hubToken.eq(l1Token)) {
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
