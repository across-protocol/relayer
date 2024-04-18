import { CONTRACT_ADDRESSES, chainIdsToCctpDomains } from "../../common";
import {
  BigNumber,
  Contract,
  TOKEN_SYMBOLS_MAP,
  TransactionResponse,
  assert,
  bnZero,
  compareAddressesSimple,
} from "../../utils";
import { cctpAddressToBytes32 } from "../../utils/CCTPUtils";
import { BaseAdapter } from "./BaseAdapter";

/**
 * An extension of the BaseAdapter class that is meant to be an intermediary
 * between adapters and the BaseAdapter class. Holds additional functions meant
 * to be used to bridge USDC via CCTP.
 */
export abstract class CCTPAdapter extends BaseAdapter {
  /**
   * Get the CCTP domain of the target chain. This is used to determine the destination
   * domain of a CCTP message.
   */
  private get l2DestinationDomain(): number {
    return chainIdsToCctpDomains[this.chainId];
  }

  /**
   * Check if an L1 token is USDC - this is a requirement to be transferred via CCTP
   * @param l1Token A Web3 address of a token
   * @returns Whether or not this token is USDC on Mainnet
   */
  protected isL1TokenUsdc(l1Token: string): boolean {
    return compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
  }

  /**
   * Check if an L2 token is USDC - this is a requirement to be transferred via CCTP
   * @param l2Token A Web3 address of a token
   * @returns Whether or not this token is USDC on the target chain
   */
  protected isL2TokenUsdc(l2Token: string): boolean {
    return compareAddressesSimple(l2Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.chainId]);
  }

  /**
   * Get the CCTP token messenger bridge contract. Used to interface with the CCTP bridge.
   * @returns The CCTP token messenger bridge contract on the hub chain
   */
  protected getL1CCTPTokenMessengerBridge(): Contract {
    const { hubChainId } = this;
    return new Contract(
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address,
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.abi,
      this.getSigner(hubChainId)
    );
  }

  protected sendCCTPTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    // Sanity check to ensure that the token is USDC as this is the only token
    // configured to be bridged via CCTP
    assert(this.isL1TokenUsdc(l1Token), "Token must be USDC from the hub chain");
    assert(this.isL2TokenUsdc(l2Token), "Token must be USDC on the target chain");

    const l1Bridge = this.getL1CCTPTokenMessengerBridge();
    const l1BridgeMethod = "depositForBurn";
    // prettier-ignore
    const l1BridgeArgs = [amount, this.l2DestinationDomain, cctpAddressToBytes32(address), l1Token];
    return this._sendTokenToTargetChain(
      l1Token,
      l2Token,
      amount,
      l1Bridge,
      l1BridgeMethod,
      l1BridgeArgs,
      2,
      bnZero,
      simMode
    );
  }
}
