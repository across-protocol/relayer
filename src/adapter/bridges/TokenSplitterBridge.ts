import { Signer } from "ethers";
import { TOKEN_SPLITTER_BRIDGES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  compareAddressesSimple,
  assert,
  EvmAddress,
  Address,
  winston,
} from "../../utils";
import { TransferTokenParams } from "../utils";

export class TokenSplitterBridge extends BaseBridgeAdapter {
  protected bridge1: BaseBridgeAdapter;
  protected bridge2: BaseBridgeAdapter;

  protected canonicalL2Token: string;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    protected l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    logger: winston.Logger
  ) {
    const [bridge1Constructor, bridge2Constructor] = TOKEN_SPLITTER_BRIDGES[l2chainId][l1Token.toNative()];
    const bridge1 = new bridge1Constructor(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token, logger);
    const bridge2 = new bridge2Constructor(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token, logger);

    super(l2chainId, hubChainId, l1Signer, [...bridge1.l1Gateways, ...bridge2.l1Gateways]);

    this.canonicalL2Token = this.resolveL2TokenAddress(l1Token);
    this.bridge1 = bridge1;
    this.bridge2 = bridge2;
  }

  private getRouteForL2Token(l2Token: Address): BaseBridgeAdapter {
    return compareAddressesSimple(l2Token.toNative(), this.canonicalL2Token) ? this.bridge1 : this.bridge2;
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    optionalParams?: TransferTokenParams
  ): Promise<BridgeTransactionDetails> {
    assert(l1Token.eq(this.l1Token));
    return this.getRouteForL2Token(l2Token).constructL1ToL2Txn(toAddress, l1Token, l2Token, amount, optionalParams);
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(l1Token.eq(this.l1Token));
    const events = await Promise.all([
      this.bridge1.queryL1BridgeInitiationEvents(l1Token, fromAddress, toAddress, eventConfig),
      this.bridge2.queryL1BridgeInitiationEvents(l1Token, fromAddress, toAddress, eventConfig),
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
    assert(l1Token.eq(this.l1Token));
    const events = await Promise.all([
      this.bridge1.queryL2BridgeFinalizationEvents(l1Token, fromAddress, toAddress, eventConfig),
      this.bridge2.queryL2BridgeFinalizationEvents(l1Token, fromAddress, toAddress, eventConfig),
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
