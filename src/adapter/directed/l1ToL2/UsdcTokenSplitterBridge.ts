import { Signer } from "ethers";
import { CONTRACT_ADDRESSES, EVM_CANONICAL_BRIDGE } from "../../../common";
import { UsdcCCTPBridge } from "../../undirected/UsdcCCTPBridge";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "../../BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  assert,
  EvmAddress,
  Address,
  winston,
} from "../../../utils";
import { TransferTokenParams } from "../../utils";

export class UsdcTokenSplitterBridge extends BaseBridgeAdapter<Signer, Signer | Provider> {
  protected cctpBridge: BaseBridgeAdapter<Signer, Signer | Provider>;
  protected canonicalBridge: BaseBridgeAdapter<Signer, Signer | Provider>;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    logger: winston.Logger
  ) {
    const canonicalBridge = new EVM_CANONICAL_BRIDGE[l2chainId](
      l2chainId,
      hubChainId,
      l1Signer,
      l2SignerOrProvider,
      l1Token,
      logger
    );

    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      EvmAddress.from(CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address),
      canonicalBridge.srcGateways[0], // Canonical Bridge should have a single L1 Gateway.
    ]);

    this.cctpBridge = new UsdcCCTPBridge(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token, logger);
    this.canonicalBridge = canonicalBridge;
  }

  private getRouteForL2Token(l2Token: Address): BaseBridgeAdapter<Signer, Signer | Provider> {
    return compareAddressesSimple(l2Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.dstChainId])
      ? this.cctpBridge
      : this.canonicalBridge;
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    optionalParams?: TransferTokenParams
  ): Promise<BridgeTransactionDetails> {
    assert(compareAddressesSimple(l1Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.srcChainId]));
    return this.getRouteForL2Token(l2Token).constructL1ToL2Txn(toAddress, l1Token, l2Token, amount, optionalParams);
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(compareAddressesSimple(l1Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.srcChainId]));
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
    assert(compareAddressesSimple(l1Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.srcChainId]));
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
