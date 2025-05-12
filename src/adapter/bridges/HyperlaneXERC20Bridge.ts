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
  isContractDeployedToAddress,
} from "../../utils";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";
import { PUBLIC_NETWORKS, HYPERLANE_NO_DOMAIN_ID, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import HYPERLANE_ROUTER_ABI from "../../common/abi/IHypXERC20Router.json";
import { CONTRACT_ADDRESSES } from "../../common";

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
  // all chains that have non-eth for gas token should go here. Example: BSC
};

export class HyperlaneXERC20Bridge extends BaseBridgeAdapter {
  readonly hubChainToken: EvmAddress;
  readonly dstToken: EvmAddress;
  private readonly hubPoolAddress: string;
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

    this.hubChainToken = l1Token;
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

    this.hubPoolAddress = CONTRACT_ADDRESSES[hubChainId]?.hubPool?.address;
    assert(isDefined(this.hubPoolAddress), `HubPool address not found for hubChainId ${hubChainId}`);

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
      this.hubChainToken.eq(l1Token),
      `this.l1Token does not match l1Token constructL1ToL2Txn was called with: ${this.hubChainToken} != ${l1Token}`
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
  This function will only return events in 2 cases:
  1. `toAddress` is spokePool and `fromAddress` is hubpool
  2. `toAddress` == `fromAddress`

  In both these cases, there are important limitations:
  1. We will return all initializations from `this.hubDomainId` to `this.dstDomainId` with recipient `toAddress`, regardless of the sender. There's no additional information
     available in `ReceivedTransferRemote` for us to discern between different senders,
  2. We will return all initializations from `this.hubDomainId` to `this.dstDomainId` with recipient `toAddress`, regardless of the sender. Same reason as above.
  */
  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    if (!this.hubChainToken.eq(l1Token)) {
      return {};
    }

    const isSpokePool = await isContractDeployedToAddress(toAddress.toAddress(), this.l2Bridge.provider);
    if (isSpokePool && fromAddress.toAddress() != this.hubPoolAddress) {
      return {};
    } else if (!fromAddress.eq(toAddress)) {
      return {};
    }

    const events = await paginatedEventQuery(
      this.l1Bridge,
      // todo: do I need to add a 3rd arg here?
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
  This function will only return events in 2 cases:
  1. `toAddress` is spokePool and `fromAddress` is hubpool
  2. `toAddress` == `fromAddress`

  In both these cases, there are important limitations:
  1. We will return all receives by spoke pool from `this.hubDomainId` to `this.dstDomainId`, regardless of the sender. There's no additional information
     available in `ReceivedTransferRemote` for us to discern between different senders,
  2. We will return all receives by `toAddress` from `this.hubDomainId` to `this.dstDomainId` regardless of the sender. Same reason as above.
  */
  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    if (!this.hubChainToken.eq(l1Token)) {
      return {};
    }

    const isSpokePool = await isContractDeployedToAddress(toAddress.toAddress(), this.l2Bridge.provider);
    if (isSpokePool && fromAddress.toAddress() != this.hubPoolAddress) {
      return {};
    } else if (!fromAddress.eq(toAddress)) {
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
