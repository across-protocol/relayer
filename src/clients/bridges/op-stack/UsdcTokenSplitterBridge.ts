import { BigNumber, Event, Signer } from "ethers";
import { DefaultERC20Bridge } from "./DefaultErc20Bridge";
import { UsdcCCTPBridge } from "./UsdcCCTPBridge";
import { EventSearchConfig, Provider, TOKEN_SYMBOLS_MAP, assert, compareAddressesSimple } from "../../../utils";
import { BridgeTransactionDetails, OpStackBridge } from "./OpStackBridgeInterface";

export class UsdcTokenSplitterBridge implements OpStackBridge {
  private readonly cctpBridge: UsdcCCTPBridge;
  private readonly canonicalBridge: DefaultERC20Bridge;

  constructor(
    private l2chainId: number,
    private hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider
  ) {
    this.cctpBridge = new UsdcCCTPBridge(l2chainId, hubChainId, l1Signer, l2SignerOrProvider);
    this.canonicalBridge = new DefaultERC20Bridge(l2chainId, hubChainId, l1Signer, l2SignerOrProvider);
  }

  /**
   * Get the correct bridge for the given L2 token address.
   * @param l2Token The L2 token address to get the bridge for.
   * @returns If the L2 token is native USDC, returns the CCTP bridge. Otherwise, returns the canonical bridge.
   */
  private getL1Bridge(l2Token: string): OpStackBridge {
    return compareAddressesSimple(l2Token, TOKEN_SYMBOLS_MAP._USDC.addresses[this.l2chainId])
      ? this.cctpBridge
      : this.canonicalBridge;
  }

  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    l2Gas: number
  ): BridgeTransactionDetails {
    // We should *only* be calling this class for USDC tokens
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP._USDC.addresses[this.hubChainId]));
    return this.getL1Bridge(l2Token).constructL1ToL2Txn(toAddress, l1Token, l2Token, amount, l2Gas);
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    // We should *only* be calling this class for USDC tokens
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP._USDC.addresses[this.hubChainId]));
    const events = await Promise.all([
      this.cctpBridge.queryL1BridgeInitiationEvents(l1Token, fromAddress, eventConfig),
      this.canonicalBridge.queryL1BridgeInitiationEvents(l1Token, fromAddress, eventConfig),
    ]);
    return events.flat();
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    // We should *only* be calling this class for USDC tokens
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP._USDC.addresses[this.hubChainId]));
    const events = await Promise.all([
      this.cctpBridge.queryL2BridgeFinalizationEvents(l1Token, fromAddress, eventConfig),
      this.canonicalBridge.queryL2BridgeFinalizationEvents(l1Token, fromAddress, eventConfig),
    ]);
    return events.flat();
  }

  get l1Gateways(): string[] {
    return [...this.cctpBridge.l1Gateways, ...this.canonicalBridge.l1Gateways];
  }
}
