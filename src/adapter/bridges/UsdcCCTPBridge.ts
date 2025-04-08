import { Contract, Signer } from "ethers";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  assert,
  toBN,
  getCctpDomainForChainId,
  Address,
  EvmAddress,
} from "../../utils";
import { processEvent } from "../utils";
import { retrieveOutstandingCCTPBridgeUSDCTransfers } from "../../utils/CCTPUtils";

export class UsdcCCTPBridge extends BaseBridgeAdapter {
  private CCTP_MAX_SEND_AMOUNT = toBN(1_000_000_000_000); // 1MM USDC.

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      EvmAddress.from(CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address),
    ]);

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].cctpMessageTransmitter;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  private get l2DestinationDomain(): number {
    return getCctpDomainForChainId(this.l2chainId);
  }

  private get l1UsdcTokenAddress(): string {
    return TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId];
  }

  protected resolveL2TokenAddress(l1Token: EvmAddress): string {
    l1Token;
    return TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId];
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    _l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(compareAddressesSimple(l1Token.toAddress(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    amount = amount.gt(this.CCTP_MAX_SEND_AMOUNT) ? this.CCTP_MAX_SEND_AMOUNT : amount;
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "depositForBurn",
      args: [amount, this.l2DestinationDomain, toAddress.toBytes32(), this.l1UsdcTokenAddress],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(compareAddressesSimple(l1Token.toAddress(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    const events = await retrieveOutstandingCCTPBridgeUSDCTransfers(
      this.getL1Bridge(),
      this.getL2Bridge(),
      eventConfig,
      this.l1UsdcTokenAddress,
      this.hubChainId,
      this.l2chainId,
      fromAddress.toAddress()
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount")),
    };
  }

  queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Lint Appeasement
    l1Token;
    fromAddress;
    eventConfig;
    assert(compareAddressesSimple(l1Token.toAddress(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));

    // The function queryL1BridgeInitiationEvents already comuptes outstanding CCTP Bridge transfers,
    // so we can return nothing here.
    return Promise.resolve({});
  }
}
