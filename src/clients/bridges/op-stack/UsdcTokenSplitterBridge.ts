import { BigNumber, Signer } from "ethers";
import { DefaultERC20Bridge } from "./DefaultErc20Bridge";
import { UsdcCCTPBridge } from "./UsdcCCTPBridge";
import { EventSearchConfig, Provider, TOKEN_SYMBOLS_MAP, assert, compareAddressesSimple } from "../../../utils";
import { BridgeTransactionDetails, OpStackBridge, OpStackEvents } from "./OpStackBridgeInterface";
import { CONTRACT_ADDRESSES } from "../../../common";

export class UsdcTokenSplitterBridge extends OpStackBridge {
  private readonly cctpBridge: UsdcCCTPBridge;
  private readonly canonicalBridge: DefaultERC20Bridge;

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address,
      CONTRACT_ADDRESSES[hubChainId][`ovmStandardBridge_${l2chainId}`].address,
    ]);
    this.cctpBridge = new UsdcCCTPBridge(l2chainId, hubChainId, l1Signer, l2SignerOrProvider);
    this.canonicalBridge = new DefaultERC20Bridge(l2chainId, hubChainId, l1Signer, l2SignerOrProvider);
  }

  /**
   * Get the correct bridge for the given L2 token address.
   * @param l2Token The L2 token address to get the bridge for.
   * @returns If the L2 token is native USDC, returns the CCTP bridge. Otherwise, returns the canonical bridge.
   */
  private getL1Bridge(l2Token: string): OpStackBridge {
    return compareAddressesSimple(l2Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId])
      ? this.cctpBridge
      : this.canonicalBridge;
  }

  protected getCCTPBridge(): UsdcCCTPBridge {
    return this.cctpBridge;
  }

  protected getCanonicalBridge(): DefaultERC20Bridge {
    return this.canonicalBridge;
  }

  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    l2Gas: number
  ): BridgeTransactionDetails {
    // We should *only* be calling this class for USDC tokens
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    return this.getL1Bridge(l2Token).constructL1ToL2Txn(toAddress, l1Token, l2Token, amount, l2Gas);
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    // We should *only* be calling this class for USDC tokens
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    const events = await Promise.all([
      this.getCCTPBridge().queryL1BridgeInitiationEvents(l1Token, fromAddress, eventConfig),
      this.getCanonicalBridge().queryL1BridgeInitiationEvents(l1Token, fromAddress, eventConfig),
    ]);
    // Reduce the events to a single Object. If there are any duplicate keys, merge the events.
    return events.reduce((acc, event) => {
      Object.entries(event).forEach(([l2Token, events]) => {
        if (l2Token in acc) {
          acc[l2Token] = acc[l2Token].concat(events);
        } else {
          acc[l2Token] = events;
        }
      });
      return acc;
    }, {});
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    // We should *only* be calling this class for USDC tokens
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    const events = await Promise.all([
      this.getCCTPBridge().queryL2BridgeFinalizationEvents(l1Token, fromAddress, eventConfig),
      this.getCanonicalBridge().queryL2BridgeFinalizationEvents(l1Token, fromAddress, eventConfig),
    ]);
    // Reduce the events to a single object. If there are any duplicate keys, merge the events.
    return events.reduce((acc, event) => {
      Object.entries(event).forEach(([l2Token, events]) => {
        if (l2Token in acc) {
          acc[l2Token] = acc[l2Token].concat(events);
        } else {
          acc[l2Token] = events;
        }
      });
      return acc;
    }, {});
  }
}
