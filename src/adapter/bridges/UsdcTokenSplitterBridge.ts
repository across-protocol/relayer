import { Signer } from "ethers";
import { CONTRACT_ADDRESSES, CANONICAL_BRIDGE } from "../../common";
import { UsdcCCTPBridge } from "./UsdcCCTPBridge";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  assert,
  EvmAddress,
  Address,
} from "../../utils";

export class UsdcTokenSplitterBridge extends BaseBridgeAdapter {
  protected cctpBridge: BaseBridgeAdapter;
  protected canonicalBridge: BaseBridgeAdapter;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress
  ) {
    const canonicalBridge = new CANONICAL_BRIDGE[l2chainId](
      l2chainId,
      hubChainId,
      l1Signer,
      l2SignerOrProvider,
      l1Token
    );

    super(l2chainId, hubChainId, l1Signer, [
      EvmAddress.from(CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address),
      canonicalBridge.l1Gateways[0], // Canonical Bridge should have a single L1 Gateway.
    ]);

    this.cctpBridge = new UsdcCCTPBridge(l2chainId, hubChainId, l1Signer, l2SignerOrProvider);
    this.canonicalBridge = canonicalBridge;
  }

  private getRouteForL2Token(l2Token: Address): BaseBridgeAdapter {
    return compareAddressesSimple(l2Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId])
      ? this.cctpBridge
      : this.canonicalBridge;
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(compareAddressesSimple(l1Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    return this.getRouteForL2Token(l2Token).constructL1ToL2Txn(toAddress, l1Token, l2Token, amount);
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(compareAddressesSimple(l1Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    const events = await Promise.all([
      this.cctpBridge.queryL1BridgeInitiationEvents(l1Token, fromAddress, toAddress, eventConfig),
      this.canonicalBridge.queryL1BridgeInitiationEvents(l1Token, fromAddress, toAddress, eventConfig),
    ]);
    // Reduce the events to a single Object. If there are any duplicate keys, merge the events.
    return events.reduce((acc, event) => {
      Object.entries(event).forEach(([l2Token, events]) => {
        acc[l2Token] = (acc[l2Token] ?? []).concat(events);
      });
      return acc;
    }, {});
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(compareAddressesSimple(l1Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    const events = await Promise.all([
      this.cctpBridge.queryL2BridgeFinalizationEvents(l1Token, fromAddress, toAddress, eventConfig),
      this.canonicalBridge.queryL2BridgeFinalizationEvents(l1Token, fromAddress, toAddress, eventConfig),
    ]);
    // Reduce the events to a single object. If there are any duplicate keys, merge the events.
    return events.reduce((acc, event) => {
      Object.entries(event).forEach(([l2Token, events]) => {
        acc[l2Token] = (acc[l2Token] ?? []).concat(events);
      });
      return acc;
    }, {});
  }
}
