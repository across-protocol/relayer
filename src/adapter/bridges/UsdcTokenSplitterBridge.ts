import { Signer } from "ethers";
import { CONTRACT_ADDRESSES, CANONICAL_BRIDGE } from "../../common";
import { UsdcCCTPBridge } from "./UsdcCCTPBridge";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { BigNumber, EventSearchConfig, Provider, TOKEN_SYMBOLS_MAP, compareAddressesSimple, assert } from "../../utils";

export class UsdcTokenSplitterBridge extends BaseBridgeAdapter {
  protected cctpBridge: BaseBridgeAdapter;
  protected canonicalBridge: BaseBridgeAdapter;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: string
  ) {
    const canonicalBridge = new CANONICAL_BRIDGE[l2chainId](
      l2chainId,
      hubChainId,
      l1Signer,
      l2SignerOrProvider,
      l1Token
    );

    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address,
      canonicalBridge.l1Gateways[0], // Canonical Bridge should have a single L1 Gateway.
    ]);

    this.cctpBridge = new UsdcCCTPBridge(l2chainId, hubChainId, l1Signer, l2SignerOrProvider);
    this.canonicalBridge = canonicalBridge;
  }

  private getRouteForL2Token(l2Token: string): BaseBridgeAdapter {
    return compareAddressesSimple(l2Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId])
      ? this.cctpBridge
      : this.canonicalBridge;
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    return this.getRouteForL2Token(l2Token).constructL1ToL2Txn(toAddress, l1Token, l2Token, amount);
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
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
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
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
