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
  CHAIN_IDs,
  EventSearchConfig,
  toBytes32,
} from "../../utils";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";
import { PUBLIC_NETWORKS, HYPERLANE_NO_DOMAIN_ID, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import HYPERLANE_ROUTER_ABI from "../../common/abi/IHypXERC20Router.json";

// source: https://github.com/hyperlane-xyz/hyperlane-registry/blob/346b18c4314cf96b41ae2da781f58fb832dbe1f8/deployments/warp_routes/EZETH/arbitrum-base-berachain-blast-bsc-ethereum-fraxtal-linea-mode-optimism-sei-swell-taiko-unichain-worldchain-zircuit-config.yaml
export const HYPERLANE_ROUTERS: { [chainId: number]: { [tokenAddress: string]: string } } = {
  [CHAIN_IDs.MAINNET]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MAINNET].toLowerCase()]: "0xC59336D8edDa9722B4f1Ec104007191Ec16f7087",
  },
  [CHAIN_IDs.ARBITRUM]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.ARBITRUM].toLowerCase()]: "0xB26bBfC6d1F469C821Ea25099017862e7368F4E8",
  },
  [CHAIN_IDs.BASE]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.BASE].toLowerCase()]: "0x2552516453368e42705D791F674b312b8b87CD9e",
  },
  [CHAIN_IDs.BLAST]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.BLAST].toLowerCase()]: "0x486b39378f99f073A3043C6Aabe8666876A8F3C5",
  },
  [CHAIN_IDs.MODE]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.MODE].toLowerCase()]: "0xC59336D8edDa9722B4f1Ec104007191Ec16f7087",
  },
  [CHAIN_IDs.LINEA]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.LINEA].toLowerCase()]: "0xC59336D8edDa9722B4f1Ec104007191Ec16f7087",
  },
  [CHAIN_IDs.UNICHAIN]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.UNICHAIN].toLowerCase()]: "0xFf0247f72b0d7ceD319D8457dD30622a2bed78B5",
  },
  [CHAIN_IDs.OPTIMISM]: {
    [TOKEN_SYMBOLS_MAP.ezETH.addresses[CHAIN_IDs.OPTIMISM].toLowerCase()]: "0xacEB607CdF59EB8022Cc0699eEF3eCF246d149e2",
  },
};

// 0.1 ETH is a default cap for chains that use ETH as their gas token
export const DEFAULT_FEE_CAP = ethers.utils.parseEther("0.1");
export const FEE_CAP_OVERRIDES: { [chainId: number]: BigNumber } = {
  // all supported chains that have non-eth for gas token should go here. Example: BSC
};

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
    l1Token: EvmAddress
  ) {
    const l1RouterAddressStr = HYPERLANE_ROUTERS[hubChainId]?.[l1Token.toAddress().toLowerCase()];
    assert(
      isDefined(l1RouterAddressStr),
      `No L1 Hyperlane router found for token ${l1Token.toAddress()} on chain ${hubChainId}`
    );
    const l1RouterEvmAddress = EvmAddress.from(l1RouterAddressStr);

    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [l1RouterEvmAddress]);

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
    const l2RouterAddressStr = HYPERLANE_ROUTERS[l2chainId]?.[l2UnderlyingTokenAddressStr.toLowerCase()];
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

    const feeCap = FEE_CAP_OVERRIDES[this.l2chainId] ?? DEFAULT_FEE_CAP;
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
      args: [this.dstDomainId, toBytes32(toAddress.toAddress()), amount],
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
      // TODO: do I need to add a 3rd arg here or will it just work?
      this.l1Bridge.filters.SentTransferRemote(this.dstDomainId, toBytes32(toAddress.toAddress())),
      eventConfig
    );

    return {
      [this.dstToken.toAddress()]: events.map((event) => {
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
      this.l2Bridge.filters.ReceivedTransferRemote(this.hubDomainId, toBytes32(toAddress.toAddress())),
      eventConfig
    );

    return {
      [this.dstToken.toAddress()]: events.map((event) => {
        return processEvent(event, "amount");
      }),
    };
  }
}
